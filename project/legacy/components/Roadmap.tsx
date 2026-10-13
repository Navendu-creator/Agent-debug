import { roadmap } from '@/data/projectData';

export function Roadmap() {
  return (
    <section id="roadmap" className="relative py-24 md:py-32 bg-paper">
      <div className="max-w-3xl mx-auto px-6">
        <div className="mb-14">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-teal mb-3">
            Build path
          </p>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-ink tracking-tight mb-4">
            Eight phases. Ship early.
          </h2>
          <p className="text-ink-soft text-lg leading-relaxed">
            Each phase leaves you with something runnable. Start with Phase 1 — layer capability later.
          </p>
        </div>

        <ol className="relative space-y-0">
          <div className="absolute left-[11px] top-3 bottom-3 w-px bg-line" />
          {roadmap.map((phase, i) => (
            <li
              key={phase.phase}
              className="relative pl-10 pb-10 last:pb-0 animate-fade-up"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <span className="absolute left-0 top-1.5 w-6 h-6 rounded-full bg-paper border-2 border-teal flex items-center justify-center font-mono text-[10px] text-teal font-semibold">
                {phase.phase}
              </span>
              <div className="flex items-baseline gap-3 mb-1 flex-wrap">
                <h3 className="font-display text-lg font-semibold text-ink">{phase.title}</h3>
                <span className="font-mono text-[10px] text-ink-muted uppercase tracking-wide">
                  {phase.status}
                </span>
              </div>
              <p className="text-sm text-ink-soft mb-3">{phase.description}</p>
              <ul className="space-y-1.5">
                {phase.items.map((item) => (
                  <li key={item} className="text-sm text-ink-muted flex gap-2">
                    <span className="text-teal">·</span>
                    {item}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>

        <p className="mt-14 pt-8 border-t border-line text-sm text-ink-soft leading-relaxed">
          <span className="font-semibold text-ink">Principle:</span> when choosing between
          impressive complexity and simple, reliable, explainable — always pick the latter.
        </p>
      </div>
    </section>
  );
}
