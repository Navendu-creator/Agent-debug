import { useState } from 'react';
import { workflowNodes } from '@/data/projectData';
import { Inbox, Filter, Database, Search, Wrench, ShieldCheck, GitPullRequest, Cpu, Clock } from 'lucide-react';

const iconMap: Record<string, typeof Inbox> = {
  Inbox,
  Filter,
  Database,
  Search,
  Wrench,
  ShieldCheck,
  GitPullRequest,
};

export function Workflow() {
  const [activeNode, setActiveNode] = useState(0);
  const node = workflowNodes[activeNode];
  const Icon = iconMap[node.icon] || Inbox;
  const isDet = node.type === 'deterministic';

  return (
    <section id="workflow" className="relative py-24 md:py-32 bg-mist">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-2xl mb-14">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-teal mb-3">Agent pipeline</p>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-ink tracking-tight mb-4">
            Seven nodes. Zero improvisation.
          </h2>
          <p className="text-ink-soft text-lg leading-relaxed">
            Deterministic steps for speed and safety. LLM nodes only where judgment is required.
          </p>
        </div>

        <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-4 mb-10">
          {workflowNodes.map((n, i) => {
            const NIcon = iconMap[n.icon] || Inbox;
            const active = i === activeNode;
            return (
              <button
                key={n.id}
                onClick={() => setActiveNode(i)}
                className={`flex-shrink-0 flex items-center gap-2.5 px-4 py-3 rounded-md border transition-all duration-200 ${
                  active
                    ? 'bg-ink text-paper border-ink shadow-soft'
                    : 'bg-paper text-ink-soft border-line hover:border-ink-muted'
                }`}
              >
                <NIcon className={`w-4 h-4 ${active ? 'text-teal' : ''}`} />
                <span className="text-sm font-medium whitespace-nowrap">
                  {i + 1}. {n.name}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid lg:grid-cols-[1.6fr_1fr] gap-8 lg:gap-12">
          <div className="animate-fade-up" key={node.id}>
            <div className="flex items-start gap-4 mb-6">
              <div className="mt-1 p-2.5 rounded-md bg-teal-soft text-teal">
                <Icon className="w-6 h-6" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <h3 className="font-display text-2xl font-semibold text-ink">{node.name}</h3>
                  <span
                    className={`font-mono text-[11px] tracking-wide px-2 py-0.5 rounded ${
                      isDet
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-teal-soft text-teal-deep border border-teal/20'
                    }`}
                  >
                    {isDet ? 'DETERMINISTIC' : 'LLM'}
                  </span>
                </div>
                <p className="text-ink-soft leading-relaxed">{node.description}</p>
              </div>
            </div>

            <ol className="space-y-3">
              {node.details.map((detail, i) => (
                <li
                  key={i}
                  className="flex gap-3 text-sm text-ink-soft leading-relaxed"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <span className="font-mono text-teal text-xs mt-0.5 w-5 flex-shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{detail}</span>
                </li>
              ))}
            </ol>
          </div>

          <aside className="lg:border-l lg:border-line lg:pl-10">
            <h4 className="font-mono text-xs tracking-[0.15em] uppercase text-ink-muted mb-5">
              Configuration
            </h4>
            <dl className="space-y-5">
              <div>
                <dt className="text-xs text-ink-muted mb-1">Type</dt>
                <dd className="font-mono text-sm text-ink">
                  {isDet ? 'Code only — no LLM' : 'LLM-powered reasoning'}
                </dd>
              </div>
              {node.model && (
                <div>
                  <dt className="text-xs text-ink-muted mb-1 flex items-center gap-1.5">
                    <Cpu className="w-3 h-3" /> Model
                  </dt>
                  <dd className="font-mono text-sm text-teal-deep">claude-{node.model}</dd>
                  <dd className="text-xs text-ink-muted mt-1">
                    {node.model === 'opus'
                      ? 'High-capability for complex fixes'
                      : 'Fast analysis model'}
                  </dd>
                </div>
              )}
              {node.maxTurns && (
                <div>
                  <dt className="text-xs text-ink-muted mb-1 flex items-center gap-1.5">
                    <Clock className="w-3 h-3" /> Max turns
                  </dt>
                  <dd className="font-mono text-sm text-ink">{node.maxTurns}</dd>
                  <dd className="text-xs text-ink-muted mt-1">Hard stop if exceeded</dd>
                </div>
              )}
              {!node.model && (
                <p className="text-sm text-ink-soft leading-relaxed border-l-2 border-teal pl-3">
                  Pure code execution — faster, cheaper, no hallucination risk.
                </p>
              )}
            </dl>
          </aside>
        </div>
      </div>
    </section>
  );
}
