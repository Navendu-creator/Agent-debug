import { Github } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-line bg-mist py-14">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid md:grid-cols-3 gap-10 mb-10">
          <div>
            <p className="font-display text-xl font-bold text-ink mb-3">
              Debug<span className="text-teal">Assist</span>
            </p>
            <p className="text-sm text-ink-soft leading-relaxed max-w-xs">
              Open-source AI debugging inspired by Uber&apos;s production system — built to be
              understood end to end.
            </p>
          </div>

          <div>
            <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-ink-muted mb-3">
              Navigate
            </h4>
            <div className="space-y-2">
              {[
                { href: '#architecture', label: 'Architecture' },
                { href: '#workflow', label: 'Workflow' },
                { href: '#tech', label: 'Tech stack' },
                { href: '#demo', label: 'Demo' },
                { href: '#roadmap', label: 'Roadmap' },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="block text-sm text-ink-soft hover:text-teal transition-colors"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-ink-muted mb-3">
              Ideas
            </h4>
            <ul className="space-y-2 text-sm text-ink-soft">
              <li>LangGraph pipeline</li>
              <li>MCP tool abstraction</li>
              <li>Evidence-backed RCA</li>
              <li>Swappable LLM providers</li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-line flex items-center justify-between flex-wrap gap-4">
          <p className="text-xs text-ink-muted">
            Learning project. Not affiliated with Uber.
          </p>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink-muted hover:text-ink transition-colors"
            aria-label="GitHub"
          >
            <Github className="w-5 h-5" />
          </a>
        </div>
      </div>
    </footer>
  );
}
