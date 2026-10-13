import assert from 'node:assert/strict';
import test from 'node:test';

import { compact } from './localAgent.js';
import type { ChatMessage } from './llm.js';

test('compact removes oldest tool messages before exceeding the budget', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'a'.repeat(1000) },
    { role: 'user', content: 'b'.repeat(2000) },
    { role: 'tool', tool_call_id: 'call-1', name: 'search', content: 'x'.repeat(4000) },
    { role: 'tool', tool_call_id: 'call-2', name: 'search', content: 'y'.repeat(4000) },
    { role: 'assistant', content: 'z'.repeat(500) },
    { role: 'assistant', content: 'done' },
  ];

  compact(messages, 6000);

  const toolCount = messages.filter((m) => m.role === 'tool').length;
  const size = messages.reduce((total, m) => total + (m.content?.length ?? 0), 0);

  assert.ok(toolCount <= 1, `expected compact to trim tool history, got ${toolCount}`);
  assert.ok(size <= 6000, `expected compact to keep total size under the budget, got ${size}`);
});
