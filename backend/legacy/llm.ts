import { config } from '../config.js';

/**
 * Minimal tool-calling chat client. Two wire formats:
 *  - 'openai': any OpenAI-compatible /chat/completions API (Gemini, Groq, OpenRouter, Together, LM Studio...)
 *  - 'ollama': Ollama's native /api/chat, which (unlike its OpenAI shim) lets us raise the context window.
 * Messages are kept in OpenAI shape internally and converted for Ollama.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name: string };

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

let lastRequestAt = 0;
let callCounter = 0;

async function throttle(): Promise<void> {
  const wait = lastRequestAt + config.llmMinIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function stripThinking(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.llmRequestTimeoutMs),
      });
    } catch (err) {
      // Connection refused/reset (e.g. Ollama reloading a model) — retry; timeouts are final.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      if (!timedOut && attempt < 6) {
        await sleep(Math.min(60_000, 3_000 * 2 ** attempt));
        continue;
      }
      throw new Error(
        `LLM request to ${new URL(url).host} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    // Free tiers rate-limit aggressively; back off and retry on 429 / transient 5xx.
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 2_000 * 2 ** attempt));
      continue;
    }
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function chatOpenAI(messages: ChatMessage[], tools: ToolDef[]): Promise<AssistantMessage> {
  const data = await postJson(
    `${config.llmBaseUrl}/chat/completions`,
    { model: config.llmModel, messages, tools, tool_choice: 'auto', temperature: 0.2 },
    config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {},
  );
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error(`LLM returned no message: ${JSON.stringify(data).slice(0, 300)}`);
  return {
    role: 'assistant',
    content: stripThinking(msg.content),
    tool_calls: msg.tool_calls?.length
      ? msg.tool_calls.map((c: ToolCall, i: number) => ({ ...c, id: c.id || `call_${++callCounter}_${i}` }))
      : undefined,
  };
}

async function chatOllama(messages: ChatMessage[], tools: ToolDef[]): Promise<AssistantMessage> {
  const ollamaMessages = messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls?.map((c) => ({
          function: { name: c.function.name, arguments: safeParse(c.function.arguments) },
        })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
    return m;
  });

  const data = await postJson(
    `${config.llmBaseUrl}/api/chat`,
    {
      model: config.llmModel,
      messages: ollamaMessages,
      tools,
      stream: false,
      think: false,
      options: { num_ctx: config.llmNumCtx, temperature: 0.2 },
    },
    {},
  );
  const msg = data?.message;
  if (!msg) throw new Error(`Ollama returned no message: ${JSON.stringify(data).slice(0, 300)}`);
  return {
    role: 'assistant',
    content: stripThinking(msg.content),
    tool_calls: msg.tool_calls?.length
      ? msg.tool_calls.map((c: { function: { name: string; arguments: unknown } }) => ({
          id: `call_${++callCounter}`,
          type: 'function' as const,
          function: {
            name: c.function.name,
            arguments:
              typeof c.function.arguments === 'string'
                ? c.function.arguments
                : JSON.stringify(c.function.arguments ?? {}),
          },
        }))
      : undefined,
  };
}

export function chat(messages: ChatMessage[], tools: ToolDef[]): Promise<AssistantMessage> {
  return config.llmApi === 'ollama' ? chatOllama(messages, tools) : chatOpenAI(messages, tools);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
