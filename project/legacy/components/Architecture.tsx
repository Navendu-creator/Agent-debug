import { Server, Brain, Wrench, GitBranch, Database, Shield, ArrowRight } from 'lucide-react';

const layers = [
  {
    title: 'Ingestion',
    icon: Server,
    items: ['Slack', 'Teams', 'REST API', 'Web UI'],
    description: 'Normalize alerts from every channel into a structured incident.',
  },
  {
    title: 'Orchestration',
    icon: Brain,
    items: ['LangGraph', 'State', 'Sub-agents', 'Guardrails'],
    description: 'A fixed pipeline — the plan is controlled, never improvised.',
  },
  {
    title: 'Tools',
    icon: Wrench,
    items: ['Kubernetes', 'CloudWatch', 'Git', 'Tracing'],
    description: 'MCP servers expose only the tools relevant to this incident.',
  },
  {
    title: 'Data',
    icon: Database,
    items: ['PostgreSQL', 'Redis', 'JSON logs'],
    description: 'Every investigation is persisted for audit and replay.',
  },
  {
    title: 'Remediation',
    icon: GitBranch,
    items: ['Fix', 'Validate', 'PR', 'Approval'],
    description: 'Separate from investigation. Destructive actions need a human.',
  },
  {
    title: 'Safety',
    icon: Shield,
    items: ['Redaction', 'Read-only', 'Turn limits'],
    description: 'Allowlisted tools only — no arbitrary shell execution.',
  },
];

export function Architecture() {
  return (
    <section id="architecture" className="relative py-24 md:py-32 bg-paper">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-2xl mb-14 animate-fade-up">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-teal mb-3">System design</p>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-ink tracking-tight mb-4">
            Six layers. One clear path.
          </h2>
          <p className="text-ink-soft text-lg leading-relaxed">
            Built so a mid-level engineer can read the whole system — not an enterprise maze.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-14 text-sm">
          {['Ingestion', 'FastAPI', 'Incident Manager', 'LangGraph', 'Result / PR'].map((step, i, arr) => (
            <div key={step} className="flex items-center gap-2">
              <span className="font-mono text-xs md:text-sm text-ink-soft px-3 py-1.5 bg-mist border border-line rounded-md">
                {step}
              </span>
              {i < arr.length - 1 && <ArrowRight className="w-3.5 h-3.5 text-ink-muted" />}
            </div>
          ))}
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-12">
          {layers.map((layer, i) => (
            <div
              key={layer.title}
              className="animate-fade-up"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <div className="flex items-center gap-3 mb-3">
                <layer.icon className="w-5 h-5 text-teal" strokeWidth={1.75} />
                <h3 className="font-display text-xl font-semibold text-ink">{layer.title}</h3>
              </div>
              <p className="text-ink-soft text-sm leading-relaxed mb-4">{layer.description}</p>
              <ul className="flex flex-wrap gap-2">
                {layer.items.map((item) => (
                  <li
                    key={item}
                    className="font-mono text-[11px] text-ink-muted border-b border-line pb-0.5"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-16 pt-10 border-t border-line">
          <p className="text-ink-soft leading-relaxed max-w-3xl">
            <span className="font-semibold text-ink">Why this shape?</span>{' '}
            Uber&apos;s Debug Assist keeps a fixed LangGraph skeleton — steps never change, only skills do.
            That removes LLM planning, cuts hallucination, and keeps the path: collect → analyze → fix → validate → PR.
          </p>
        </div>
      </div>
    </section>
  );
}
