import { techStack, tools } from '@/data/projectData';
import {
  Check,
  Box,
  Cloud,
  GitBranch,
  Route,
  ScrollText,
  Ticket,
  Flag,
  AlertTriangle,
  Database,
  Container,
  GitMerge,
  Terminal,
} from 'lucide-react';

const iconMap: Record<string, typeof Box> = {
  Box,
  Cloud,
  GitBranch,
  Route,
  ScrollText,
  Ticket,
  Flag,
  AlertTriangle,
  Database,
  Container,
  GitMerge,
  Terminal,
};

export function TechStack() {
  return (
    <section id="tech" className="relative py-24 md:py-32 bg-paper">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-2xl mb-14">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-teal mb-3">
            Free-tier ready
          </p>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-ink tracking-tight mb-4">
            Stack you can run today.
          </h2>
          <p className="text-ink-soft text-lg leading-relaxed">
            Swap the LLM with one env var. Everything else has an open-source path.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 mb-20">
          {techStack.map((cat) => (
            <div key={cat.category}>
              <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-ink-muted mb-4 pb-2 border-b border-line">
                {cat.category}
              </h3>
              <ul className="space-y-4">
                {cat.items.map((item) => (
                  <li key={item.name}>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-ink">{item.name}</span>
                      <span
                        className={`font-mono text-[10px] ${
                          item.free ? 'text-teal' : 'text-ink-muted'
                        }`}
                      >
                        {item.free ? 'FREE' : 'PAID'}
                      </span>
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">{item.purpose}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mb-8">
          <h3 className="font-display text-2xl font-semibold text-ink mb-2">Tool registry</h3>
          <p className="text-ink-soft text-sm max-w-2xl">
            Each tool is an independent module. The agent only sees what the incident needs.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
          {tools.map((tool, i) => {
            const Icon = iconMap[tool.icon] || Box;
            return (
              <div
                key={tool.name}
                className="flex gap-3 py-4 border-b border-line animate-fade-up"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <Icon className="w-4 h-4 text-teal mt-1 flex-shrink-0" strokeWidth={1.75} />
                <div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <h4 className="text-sm font-semibold text-ink">{tool.name}</h4>
                    <span className="text-[11px] text-ink-muted">{tool.category}</span>
                  </div>
                  <p className="text-xs text-ink-soft mb-2 leading-relaxed">{tool.description}</p>
                  <p className="flex items-center gap-1.5 text-[11px] text-teal">
                    <Check className="w-3 h-3" />
                    {tool.freeAlternative}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-16 p-8 md:p-10 rounded-lg bg-mist border border-line">
          <h3 className="font-display text-xl font-semibold text-ink mb-2">
            LLM provider abstraction
          </h3>
          <p className="text-ink-soft text-sm mb-6 max-w-2xl">
            Talk to a common <code className="font-mono text-teal text-xs">LLMProvider</code> interface.
            Change one variable — no agent code changes.
          </p>
          <div className="flex flex-wrap gap-3">
            {[
              { env: 'LLM_PROVIDER=ollama', free: true },
              { env: 'LLM_PROVIDER=openai', free: false },
              { env: 'LLM_PROVIDER=anthropic', free: false },
              { env: 'LLM_PROVIDER=groq', free: true },
            ].map((p) => (
              <code
                key={p.env}
                className="font-mono text-xs px-3 py-2 rounded-md bg-paper border border-line text-ink"
              >
                {p.env}
                <span className={`ml-2 ${p.free ? 'text-teal' : 'text-ink-muted'}`}>
                  {p.free ? 'free' : 'paid'}
                </span>
              </code>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
