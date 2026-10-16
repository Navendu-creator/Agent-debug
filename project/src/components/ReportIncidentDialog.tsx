import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { api, ApiError, type NewIncident, type Severity } from '@/lib/api';
import { useData } from '@/lib/data';
import { repositories, useHealth } from '@/lib/health';
import { Select } from './menu';
import { ErrorBox, RepoIcon } from './ui';

const label = 'mb-1.5 block text-xs font-medium text-fg-soft';

const SEVERITIES: Array<{ id: Severity; label: string; on: string }> = [
  { id: 'critical', label: 'Critical', on: 'bg-rose-500/20 text-rose-200 ring-rose-500/60' },
  { id: 'high', label: 'High', on: 'bg-orange-500/20 text-orange-200 ring-orange-500/60' },
  { id: 'medium', label: 'Medium', on: 'bg-amber-500/20 text-amber-100 ring-amber-500/60' },
  { id: 'low', label: 'Low', on: 'bg-slate-500/25 text-slate-200 ring-slate-400/60' },
];

export function ReportIncidentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { operator, refresh } = useData();
  const [form, setForm] = useState<NewIncident>({
    title: '',
    description: '',
    severity: 'medium',
    service: '',
    environment: 'production',
    logs: '',
    owner: operator,
  });
  const { health } = useHealth();
  const repos = repositories(health);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Without health data the form still works: the server picks the default repository.
  const defaultRepo = health?.defaultRepo;
  useEffect(() => {
    if (defaultRepo) setForm((f) => ({ ...f, repo: f.repo ?? defaultRepo }));
  }, [defaultRepo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof NewIncident>(key: K, value: NewIncident[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const incident = await api.create(form);
      void refresh();
      onCreated(incident.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.details) setFieldErrors(err.details);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldError = (key: string) =>
    fieldErrors[key]?.length ? <p className="mt-1 text-xs text-rose-300">{fieldErrors[key].join(', ')}</p> : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form onSubmit={submit} className="w-full max-w-xl animate-fade-up overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-2xl shadow-black/60">
        <div className="h-1 bg-gradient-to-r from-violet-500 via-fuchsia-400 to-cyan-400" />
        <div className="flex items-center justify-between px-6 pt-5">
          <div>
            <h2 id="report-title" className="font-display text-xl font-semibold text-fg">Report an incident</h2>
            <p className="text-xs text-fg-muted">Teams is notified first, then Nagent starts investigating.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-fg-muted hover:bg-panel-3 hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className={label} htmlFor="title">Title *</label>
            <input id="title" required minLength={3} maxLength={200} autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Checkout requests returning 504" className="field" />
            {fieldError('title')}
          </div>
          <div>
            <label className={label} htmlFor="description">Description</label>
            <textarea id="description" rows={3} maxLength={8000} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What is happening, since when, who is affected? Name the module or file if you know it." className="field resize-y" />
            {fieldError('description')}
          </div>
          <div>
            <span className={label}>Severity</span>
            <div className="grid grid-cols-4 gap-2">
              {SEVERITIES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => set('severity', s.id)}
                  aria-pressed={form.severity === s.id}
                  className={`rounded-xl px-2 py-2 text-xs font-semibold ring-1 transition ${
                    form.severity === s.id ? s.on : 'bg-panel-2 text-fg-muted ring-edge hover:text-fg'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {repos.length > 0 && (
            <div>
              <span className={label}>Repository</span>
              {repos.length > 1 ? (
                <Select
                  ariaLabel="Repository"
                  fullWidth
                  className="h-10 w-full rounded-xl text-sm"
                  panelClassName="w-full"
                  value={form.repo ?? repos[0].id}
                  onChange={(v) => set('repo', v)}
                  options={repos.map((r) => ({
                    value: r.id,
                    label: r.name,
                    description: `${r.provider === 'gitlab' ? 'GitLab' : 'GitHub'} · ${r.baseBranch ?? 'main'}${r.isDefault ? ' · default' : ''}`,
                    icon: <RepoIcon provider={r.provider} />,
                  }))}
                />
              ) : (
                <div className="flex items-center gap-2.5 rounded-xl border border-edge bg-panel-2 px-3 py-2.5 text-sm">
                  <RepoIcon provider={repos[0].provider} />
                  <span className="truncate text-fg">{repos[0].name}</span>
                  <span className="ml-auto font-mono text-[11px] text-fg-muted">{repos[0].baseBranch ?? 'main'}</span>
                </div>
              )}
              {fieldError('repo')}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="service">Service</label>
              <input id="service" maxLength={120} value={form.service} onChange={(e) => set('service', e.target.value)} placeholder="payment-api" className="field" />
              {fieldError('service')}
            </div>
            <div>
              <label className={label} htmlFor="environment">Environment</label>
              <input id="environment" list="env-options" maxLength={60} value={form.environment} onChange={(e) => set('environment', e.target.value)} placeholder="production" className="field" />
              <datalist id="env-options">
                {['production', 'staging', 'dev'].map((e) => (
                  <option key={e} value={e} />
                ))}
              </datalist>
              {fieldError('environment')}
            </div>
          </div>
          <div>
            <label className={label} htmlFor="owner">Owner <span className="text-fg-muted">(optional)</span></label>
            <input id="owner" maxLength={60} value={form.owner} onChange={(e) => set('owner', e.target.value)} placeholder="Who is responsible?" className="field" />
            {fieldError('owner')}
          </div>
          <div>
            <label className={label} htmlFor="logs">Logs or error message <span className="text-fg-muted">(optional)</span></label>
            <textarea id="logs" rows={6} maxLength={20000} value={form.logs} onChange={(e) => set('logs', e.target.value)} placeholder="Paste the relevant log lines, stack trace or terraform output" className="field resize-y font-mono text-xs" />
            {fieldError('logs')}
          </div>
          {error && <ErrorBox message={error} />}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge bg-panel-2/60 px-6 py-4">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Report & investigate
          </button>
        </div>
      </form>
    </div>
  );
}
