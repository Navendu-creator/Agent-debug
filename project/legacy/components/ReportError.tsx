import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';

type Severity = 'P1' | 'P2' | 'P3' | 'P4';

interface IncidentEvent {
  at: string;
  type: string;
  message: string;
}

interface Incident {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  source: string;
  status: string;
  repoUrl: string;
  branch?: string;
  prUrl?: string;
  summary?: string;
  report?: {
    rootCause?: string;
    fix?: string;
    tests?: string;
    testsPassed?: boolean;
  };
  error?: string;
  timeline: IncidentEvent[];
}

export function ReportError() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>('P2');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);

  const refreshList = async () => {
    try {
      const res = await fetch('/api/incidents');
      if (!res.ok) return;
      const data = await res.json();
      setIncidents(data.incidents ?? []);
    } catch {
      /* backend may be down */
    }
  };

  useEffect(() => {
    void refreshList();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/incidents/${activeId}`);
        if (!res.ok) return;
        const data = (await res.json()) as Incident;
        if (!cancelled) {
          setIncident(data);
          if (data.status === 'completed' || data.status === 'failed' || data.status === 'pr_ready') {
            void refreshList();
          }
        }
      } catch {
        /* ignore transient errors */
      }
    };

    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeId]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          severity,
          source: 'web',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ? JSON.stringify(data.error) : 'Failed to create incident');
      }
      setActiveId(data.incident.id);
      setIncident(data.incident);
      setTitle('');
      setDescription('');
      void refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section id="report" className="relative py-24 md:py-32 bg-paper border-y border-line">
      <div className="max-w-6xl mx-auto px-6">
        <div className="max-w-2xl mb-10">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-coral mb-3">
            Live intake
          </p>
          <h2 className="font-display text-3xl md:text-5xl font-bold text-ink tracking-tight mb-4">
            Report an error. Get a Teams ticket + fix.
          </h2>
          <p className="text-ink-soft text-lg leading-relaxed">
            Submit a bug here (or from Teams). DebugAssist posts a channel ticket, investigates{' '}
            <span className="font-mono text-sm text-ink">Navendu-creator/infra-setup</span>, and
            opens a PR when a fix is ready.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-10">
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wide text-ink-muted mb-1.5">
                Title
              </label>
              <input
                required
                minLength={3}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Terraform apply fails on VPC module"
                className="w-full px-3 py-2.5 rounded-md border border-line bg-mist text-ink text-sm focus:outline-none focus:border-teal"
              />
            </div>
            <div>
              <label className="block text-xs font-mono uppercase tracking-wide text-ink-muted mb-1.5">
                Details
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder="Paste stack traces, failing commands, expected vs actual…"
                className="w-full px-3 py-2.5 rounded-md border border-line bg-mist text-ink text-sm focus:outline-none focus:border-teal resize-y"
              />
            </div>
            <div>
              <label className="block text-xs font-mono uppercase tracking-wide text-ink-muted mb-1.5">
                Severity
              </label>
              <div className="flex flex-wrap gap-2">
                {(['P1', 'P2', 'P3', 'P4'] as Severity[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeverity(s)}
                    className={`px-3 py-1.5 rounded-md font-mono text-xs border transition-colors ${
                      severity === s
                        ? s === 'P1'
                          ? 'bg-coral text-white border-coral'
                          : 'bg-ink text-paper border-ink'
                        : 'bg-paper text-ink-soft border-line hover:border-ink-muted'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-sm text-coral bg-coral-soft border border-coral/20 rounded-md p-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>
                  {error}. Is the backend running on port 8080?
                </span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md bg-teal text-white font-semibold hover:bg-teal-deep transition-colors disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Opening ticket…
                </>
              ) : (
                <>
                  <AlertTriangle className="w-4 h-4" /> Report & start fix
                </>
              )}
            </button>
          </form>

          <div className="rounded-lg border border-line bg-mist p-5 min-h-[280px]">
            {!incident ? (
              <div className="h-full flex flex-col justify-center text-ink-muted text-sm">
                <p className="mb-4">Live status appears here after you report.</p>
                <button
                  type="button"
                  onClick={() => void refreshList()}
                  className="inline-flex items-center gap-2 text-teal text-sm"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Refresh recent incidents
                </button>
                {incidents.length > 0 && (
                  <ul className="mt-4 space-y-2">
                    {incidents.slice(0, 5).map((inc) => (
                      <li key={inc.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveId(inc.id);
                            setIncident(inc);
                          }}
                          className="text-left text-sm text-ink hover:text-teal"
                        >
                          <span className="font-mono text-xs text-ink-muted">{inc.id}</span>{' '}
                          {inc.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div>
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    <p className="font-mono text-xs text-ink-muted mb-1">{incident.id}</p>
                    <h3 className="font-display text-lg font-semibold text-ink">{incident.title}</h3>
                  </div>
                  <span className="font-mono text-[11px] px-2 py-1 rounded bg-paper border border-line text-ink-soft uppercase">
                    {incident.status}
                  </span>
                </div>

                {incident.prUrl && (
                  <a
                    href={incident.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-teal mb-4"
                  >
                    Open PR <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}

                {incident.error && (
                  <p className="text-sm text-coral mb-3">{incident.error}</p>
                )}

                {incident.branch && (
                  <p className="font-mono text-xs text-ink-muted mb-3">branch: {incident.branch}</p>
                )}

                {incident.report ? (
                  <dl className="text-sm mb-4 space-y-2">
                    {incident.report.rootCause && (
                      <div>
                        <dt className="font-mono text-[11px] uppercase text-ink-muted">Root cause</dt>
                        <dd className="text-ink-soft whitespace-pre-wrap">{incident.report.rootCause}</dd>
                      </div>
                    )}
                    {incident.report.fix && (
                      <div>
                        <dt className="font-mono text-[11px] uppercase text-ink-muted">Fix</dt>
                        <dd className="text-ink-soft whitespace-pre-wrap">{incident.report.fix}</dd>
                      </div>
                    )}
                    {incident.report.tests && (
                      <div>
                        <dt className="font-mono text-[11px] uppercase text-ink-muted">
                          Tests{' '}
                          {incident.report.testsPassed === true ? (
                            <span className="text-teal">· passed</span>
                          ) : incident.report.testsPassed === false ? (
                            <span className="text-coral">· not passing</span>
                          ) : null}
                        </dt>
                        <dd className="text-ink-soft whitespace-pre-wrap">{incident.report.tests}</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  incident.summary && (
                    <p className="text-sm text-ink-soft mb-4 whitespace-pre-wrap">{incident.summary}</p>
                  )
                )}

                <ol className="space-y-3 max-h-64 overflow-y-auto scrollbar-thin">
                  {incident.timeline.map((ev, i) => (
                    <li key={`${ev.at}-${i}`} className="flex gap-3 text-sm">
                      {ev.type === 'error' ||
                      (ev.type === 'test' && incident.report?.testsPassed === false) ? (
                        <AlertTriangle className="w-4 h-4 text-coral flex-shrink-0 mt-0.5" />
                      ) : ev.type === 'done' || ev.type === 'pr' || ev.type === 'test' ? (
                        <CheckCircle2 className="w-4 h-4 text-teal flex-shrink-0 mt-0.5" />
                      ) : (
                        <Loader2
                          className={`w-4 h-4 text-ink-muted flex-shrink-0 mt-0.5 ${
                            i === incident.timeline.length - 1 &&
                            !['completed', 'failed', 'pr_ready'].includes(incident.status)
                              ? 'animate-spin'
                              : ''
                          }`}
                        />
                      )}
                      <div>
                        <p className="text-ink">{ev.message}</p>
                        <p className="font-mono text-[10px] text-ink-muted">
                          {new Date(ev.at).toLocaleTimeString()} · {ev.type}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
