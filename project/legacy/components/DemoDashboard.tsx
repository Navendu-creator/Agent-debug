import { useState } from 'react';
import { mockIncident, kubernetesFailures } from '@/data/projectData';
import type { EvidenceItem } from '@/types';
import {
  AlertTriangle,
  Activity,
  GitBranch,
  Server,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronRight,
  Zap,
  ShieldCheck,
  Terminal,
  Wrench,
  Eye,
  Brain,
  ArrowRight,
  Copy,
  Play,
  Search,
} from 'lucide-react';

const timelineIcons: Record<EvidenceItem['type'], typeof AlertTriangle> = {
  deployment: GitBranch,
  error: AlertTriangle,
  metric: Activity,
  log: Terminal,
  restart: Zap,
};

const timelineColors: Record<EvidenceItem['type'], string> = {
  deployment: 'text-teal bg-teal-soft',
  error: 'text-coral bg-coral-soft',
  metric: 'text-amber-700 bg-amber-50',
  log: 'text-ink-muted bg-mist',
  restart: 'text-orange-600 bg-orange-50',
};

const agentStatusConfig = {
  running: { color: 'text-amber-700', dot: 'bg-amber-500 animate-pulse-soft' },
  complete: { color: 'text-teal-deep', dot: 'bg-teal' },
  pending: { color: 'text-ink-muted', dot: 'bg-line' },
  failed: { color: 'text-coral', dot: 'bg-coral' },
};

const findingTypeConfig = {
  OBSERVED: { color: 'text-teal-deep', bg: 'bg-teal-soft', icon: Eye },
  INFERRED: { color: 'text-amber-700', bg: 'bg-amber-50', icon: Brain },
  UNKNOWN: { color: 'text-ink-muted', bg: 'bg-mist', icon: AlertTriangle },
};

export function DemoDashboard() {
  const [activeTab, setActiveTab] = useState<'timeline' | 'agents' | 'rca' | 'fix'>('timeline');
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null);
  const [showSubmitFlow, setShowSubmitFlow] = useState(false);
  const [submitted, setSubmitted] = useState(true);

  const inc = mockIncident;

  const tabs = [
    { id: 'timeline' as const, label: 'Timeline', icon: Clock },
    { id: 'agents' as const, label: 'Agents', icon: Brain },
    { id: 'rca' as const, label: 'Root cause', icon: Search },
    { id: 'fix' as const, label: 'Fix', icon: Wrench },
  ];

  return (
    <section id="demo" className="relative py-24 md:py-32 bg-mist">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-2xl mb-12">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-coral mb-3">
            Live demo
          </p>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-ink tracking-tight mb-4">
            Investigation, as the engineer sees it.
          </h2>
          <p className="text-ink-soft text-lg leading-relaxed">
            Every finding is labeled and backed by evidence — never presented as magic.
          </p>
        </div>

        <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg bg-paper border border-line">
          <Terminal className="w-4 h-4 text-teal flex-shrink-0" />
          <code className="flex-1 text-xs sm:text-sm font-mono text-ink-soft overflow-x-auto">
            <span className="text-teal">$</span> curl -X POST localhost:8000/incidents -d
            &apos;{'{'}&quot;title&quot;: &quot;payment-api is crashing&quot;{'}'}&apos;
          </code>
          <button
            onClick={() => {
              setShowSubmitFlow(true);
              setSubmitted(false);
              setTimeout(() => setSubmitted(true), 2000);
            }}
            className="px-4 py-2 rounded-md bg-ink text-paper text-sm font-medium hover:bg-ink/90 transition-colors flex items-center gap-2 flex-shrink-0"
          >
            <Play className="w-3.5 h-3.5" /> Simulate
          </button>
        </div>

        {showSubmitFlow && !submitted && (
          <div className="mb-6 p-4 rounded-lg bg-amber-50 border border-amber-200 flex items-center gap-3 animate-fade-up">
            <div className="w-4 h-4 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
            <span className="text-sm text-amber-800">Investigation queued — agent starting…</span>
          </div>
        )}

        <div className="rounded-lg bg-paper border border-line shadow-soft overflow-hidden">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between flex-wrap gap-3 bg-mist/50">
            <span className="font-mono text-xs text-ink-muted">
              debug-assist / incidents / {inc.id}
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-coral-soft text-coral border border-coral/20">
                {inc.severity}
              </span>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-teal-soft text-teal-deep border border-teal/20">
                {inc.status}
              </span>
            </div>
          </div>

          <div className="px-5 py-6 border-b border-line">
            <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
              <div>
                <h3 className="font-display text-xl font-semibold text-ink mb-2">{inc.title}</h3>
                <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
                  <span className="flex items-center gap-1.5">
                    <Server className="w-3.5 h-3.5" /> {inc.service}
                  </span>
                  <span>{inc.environment}</span>
                  <span className="font-mono text-xs">{inc.category}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-ink-muted mb-0.5">Confidence</div>
                <div className="font-display text-3xl font-bold text-teal">{inc.confidence}%</div>
              </div>
            </div>

            <div className="p-4 rounded-md bg-amber-50/80 border border-amber-100">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span className="text-sm font-semibold text-amber-800">Root cause</span>
              </div>
              <p className="text-sm text-ink-soft leading-relaxed">{inc.rootCause}</p>
            </div>
          </div>

          <div className="flex border-b border-line overflow-x-auto scrollbar-thin">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'text-teal border-teal'
                    : 'text-ink-muted border-transparent hover:text-ink'
                }`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          <div className="p-5 md:p-6">
            {activeTab === 'timeline' && (
              <div className="relative space-y-0">
                <div className="absolute left-4 top-2 bottom-2 w-px bg-line" />
                {inc.timeline.map((event, i) => {
                  const Icon = timelineIcons[event.type];
                  const colorClass = timelineColors[event.type];
                  return (
                    <div
                      key={event.id}
                      className="relative pl-12 pb-5 animate-fade-up"
                      style={{ animationDelay: `${i * 45}ms` }}
                    >
                      <div
                        className={`absolute left-0 w-8 h-8 rounded-md flex items-center justify-center ${colorClass}`}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-ink-muted">{event.timestamp}</span>
                        <span className="text-sm font-medium text-ink">{event.event}</span>
                      </div>
                      <p className="text-xs text-ink-muted mt-1">{event.detail}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === 'agents' && (
              <div className="space-y-2">
                {inc.agents.map((agent, i) => {
                  const config = agentStatusConfig[agent.status];
                  return (
                    <div
                      key={agent.id}
                      className="flex items-center gap-4 py-3 border-b border-line last:border-0 animate-fade-up"
                      style={{ animationDelay: `${i * 50}ms` }}
                    >
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${config.dot}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-ink">{agent.name}</span>
                          <span className={`font-mono text-[10px] ${config.color}`}>
                            {agent.status.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-xs text-ink-muted mt-0.5">{agent.findings}</p>
                      </div>
                      <span className="font-mono text-xs text-ink-muted flex-shrink-0">
                        {agent.duration}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === 'rca' && (
              <div className="space-y-4">
                {inc.findings.map((finding, i) => {
                  const config = findingTypeConfig[finding.type];
                  const isExpanded = expandedEvidence === finding.id;
                  const Icon = config.icon;
                  return (
                    <div
                      key={finding.id}
                      className="py-4 border-b border-line last:border-0 animate-fade-up"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`p-2 rounded-md ${config.bg} flex-shrink-0`}>
                          <Icon className={`w-4 h-4 ${config.color}`} />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span
                              className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${config.bg} ${config.color}`}
                            >
                              {finding.type}
                            </span>
                            <span className="text-xs text-ink-muted">
                              {Math.round(finding.confidence * 100)}% confidence
                            </span>
                          </div>
                          <h4 className="text-sm font-semibold text-ink mb-1">{finding.finding}</h4>
                          <p className="text-xs text-ink-soft mb-3 leading-relaxed">
                            {finding.reasoning}
                          </p>
                          <button
                            onClick={() =>
                              setExpandedEvidence(isExpanded ? null : finding.id)
                            }
                            className="flex items-center gap-1 text-xs text-ink-muted hover:text-ink transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            Evidence ({finding.evidence.length})
                          </button>
                          {isExpanded && (
                            <ul className="mt-3 space-y-1.5 pl-3 border-l-2 border-line">
                              {finding.evidence.map((ev, j) => (
                                <li key={j} className="font-mono text-xs text-ink-soft">
                                  {ev}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-ink-soft leading-relaxed pt-2 flex gap-2">
                  <ShieldCheck className="w-4 h-4 text-teal flex-shrink-0" />
                  OBSERVED from data · INFERRED from reasoning · UNKNOWN needs more signal. Inferences
                  are never sold as facts.
                </p>
              </div>
            )}

            {activeTab === 'fix' && (
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Wrench className="w-4 h-4 text-teal" />
                    <h4 className="text-sm font-semibold text-ink">Recommended fix</h4>
                  </div>
                  <p className="text-sm text-ink-soft mb-4">{inc.suggestedFix.action}</p>
                  <div className="grid sm:grid-cols-2 gap-4 mb-4 text-sm">
                    <div>
                      <span className="text-xs text-ink-muted block mb-1">Risk</span>
                      <span className="font-mono text-amber-700">{inc.suggestedFix.risk}</span>
                    </div>
                    <div>
                      <span className="text-xs text-ink-muted block mb-1">Expected</span>
                      <span className="text-ink-soft">{inc.suggestedFix.expectedResult}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-ink rounded-md">
                    <Terminal className="w-4 h-4 text-white/40 flex-shrink-0" />
                    <code className="flex-1 text-xs font-mono text-teal overflow-x-auto">
                      {inc.suggestedFix.command}
                    </code>
                    <button className="text-white/40 hover:text-white transition-colors" aria-label="Copy">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="p-4 rounded-md bg-teal-soft border border-teal/15">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="w-4 h-4 text-teal" />
                    <span className="font-mono text-sm text-teal-deep">{inc.validation.result}</span>
                  </div>
                  <p className="text-xs text-ink-soft mb-1">{inc.validation.test}</p>
                  <p className="text-xs text-ink-muted">{inc.validation.details}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button className="px-4 py-2.5 rounded-md bg-teal text-white text-sm font-medium hover:bg-teal-deep transition-colors flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> Approve
                  </button>
                  <button className="px-4 py-2.5 rounded-md border border-line bg-paper text-ink text-sm font-medium hover:bg-mist transition-colors flex items-center gap-2">
                    <GitBranch className="w-4 h-4" /> Branch
                  </button>
                  <button className="px-4 py-2.5 rounded-md border border-line bg-paper text-ink text-sm font-medium hover:bg-mist transition-colors flex items-center gap-2">
                    <ArrowRight className="w-4 h-4" /> Create PR
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-16">
          <h3 className="font-display text-xl font-semibold text-ink mb-2">
            Kubernetes failures covered
          </h3>
          <p className="text-ink-soft text-sm mb-6">
            Detected automatically from events, restarts, and exit codes.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5">
            {kubernetesFailures.map((failure) => (
              <div key={failure.name} className="py-3 border-b border-line">
                <h4 className="font-mono text-sm font-semibold text-coral mb-1">{failure.name}</h4>
                <p className="text-xs text-ink-soft mb-2">{failure.description}</p>
                <p className="font-mono text-[10px] text-ink-muted">{failure.detection}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
