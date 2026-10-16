import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Select } from '@/components/menu';
import { useToast } from '@/components/feedback';
import { Dot, PageHeader, Panel, RepoIcon, Spinner } from '@/components/ui';
import { useData } from '@/lib/data';
import { aiReady, repositories, useHealth } from '@/lib/health';

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-edge py-3 first:border-t-0">
      <div>
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="text-xs text-fg-muted">{hint}</p>}
      </div>
      <div className="text-sm text-fg-soft">{children}</div>
    </div>
  );
}

function readPageSize(): string {
  try {
    return localStorage.getItem('nagent.pageSize') ?? '10';
  } catch {
    return '10';
  }
}

/** Personal preferences (this browser) and a read-only view of the server configuration. */
export function Settings() {
  const { operator, setOperator } = useData();
  const { health } = useHealth();
  const toast = useToast();
  const [name, setName] = useState(operator);
  const [pageSize, setPageSize] = useState(readPageSize);

  if (!health) return <Spinner label="Loading…" />;
  const { ai, github, teams, webhooks } = health;
  const repos = repositories(health);

  const saveName = () => {
    setOperator(name);
    toast({ tone: 'success', title: name.trim() ? `Saved — actions are recorded as ${name.trim()}` : 'Name cleared' });
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Settings" subtitle="Your preferences are stored in this browser. Server settings come from backend/.env." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Your profile & preferences" bodyClassName="px-5 pb-3 pt-2">
          <Row label="Your name" hint="Shown in the audit log for approvals and other actions. There is no login — anyone can set any name.">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveName();
              }}
              className="flex gap-2"
            >
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Navendu Dixit" className="field h-9 w-52 py-0" />
              <button type="submit" disabled={name.trim() === operator} className="btn-primary h-9 px-3 text-xs">
                <Check className="h-4 w-4" /> Save
              </button>
            </form>
          </Row>
          <Row label="Rows per page" hint="Incident table">
            <Select
              ariaLabel="Rows per page"
              align="right"
              value={pageSize}
              onChange={(v) => {
                setPageSize(v);
                try {
                  localStorage.setItem('nagent.pageSize', v);
                } catch {
                  // per-browser only
                }
              }}
              options={['10', '20', '50'].map((v) => ({ value: v, label: `${v} rows` }))}
            />
          </Row>
          <Row label="Keyboard shortcuts">
            <span className="text-xs">
              <kbd className="kbd">N</kbd> new incident · <kbd className="kbd">/</kbd> search · <kbd className="kbd">Esc</kbd> close
            </span>
          </Row>
        </Panel>

        <Panel title="AI engine" bodyClassName="px-5 pb-3 pt-2">
          <Row label="Status">
            <span className="flex items-center gap-2">
              <Dot tone={aiReady(health) ? 'ok' : ai.reachable ? 'warn' : 'error'} />
              {ai.demoMode ? 'Demo mode (no AI)' : !ai.reachable ? 'Ollama unreachable' : ai.modelAvailable ? 'Ready' : 'Model downloading'}
            </span>
          </Row>
          <Row label="Model" hint="OLLAMA_MODEL">
            <span className="font-mono">{ai.model}</span>
          </Row>
          <Row label="Endpoint" hint="OLLAMA_BASE_URL">
            <span className="font-mono">{ai.baseUrl}</span>
          </Row>
          <Row label="CPU threads" hint="OLLAMA_NUM_THREAD">
            {ai.numThread ?? 'Ollama default'}
          </Row>
          <Row label="Timeout" hint="AI_TIMEOUT_MS">
            {ai.timeoutMinutes ? `${ai.timeoutMinutes} minutes` : '—'}
          </Row>
        </Panel>

        <Panel title="Approval policy" bodyClassName="px-5 pb-3 pt-2">
          <Row label="Pull requests" hint="AUTO_CREATE_PR">
            {github.autoCreatePr ? (
              <span className="flex items-center gap-2 text-amber-200">
                <Dot tone="warn" /> Created automatically after validation
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Dot tone="ok" /> Human approval required
              </span>
            )}
          </Row>
          <Row label="Merging">Never automatic — merge on GitHub/GitLab</Row>
          <Row label="Demo analyses">Cannot open real PRs</Row>
        </Panel>

        <Panel title="Integrations" bodyClassName="px-5 pb-3 pt-2">
          <Row label="Microsoft Teams" hint="TEAMS_WEBHOOK_URL">
            <span className="flex items-center gap-2">
              <Dot tone={teams.configured ? 'ok' : 'off'} /> {teams.configured ? 'Notifications on' : 'Not configured'}
            </span>
          </Row>
          <Row label="Alert webhook" hint="POST /api/webhooks/alerts · WEBHOOK_SECRET">
            <span className="flex items-center gap-2">
              <Dot tone={webhooks.secretConfigured ? 'ok' : 'warn'} /> {webhooks.secretConfigured ? 'Secret set' : 'No secret — open to anyone'}
            </span>
          </Row>
          <Row label="Repositories">
            <span className="flex flex-wrap justify-end gap-2">
              {repos.length ? repos.map((r) => <RepoIcon key={r.id} provider={r.provider} />) : 'None'}
              <a href="#/repositories" className="text-xs text-violet-300 hover:underline">
                {repos.length} configured →
              </a>
            </span>
          </Row>
        </Panel>
      </div>
    </div>
  );
}
