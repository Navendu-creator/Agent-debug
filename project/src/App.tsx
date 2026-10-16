import { useEffect, useState } from 'react';
import { FeedbackProvider } from '@/components/feedback';
import { IncidentDetail } from '@/components/IncidentDetail';
import { Sidebar, Topbar, type Page } from '@/components/layout';
import { ReportIncidentDialog } from '@/components/ReportIncidentDialog';
import { DataProvider } from '@/lib/data';
import { isTyping } from '@/lib/format';
import { HealthProvider } from '@/lib/health';
import { Approvals } from '@/pages/Approvals';
import { AuditLog } from '@/pages/AuditLog';
import { Incidents } from '@/pages/Incidents';
import { Overview } from '@/pages/Overview';
import { Repositories } from '@/pages/Repositories';
import { Services } from '@/pages/Services';
import { Settings } from '@/pages/Settings';

function useHash(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [hash, (h: string) => (window.location.hash = h)];
}

const PAGES: Page[] = ['overview', 'incidents', 'services', 'repositories', 'approvals', 'audit', 'settings'];

/** "#/incidents/INC-1" → incident page; "#/incidents?view=open" → page + query. */
function route(hash: string): { page: Page; id?: string; query: URLSearchParams } {
  const [path, qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const [first, id] = path.split('/');
  const page = (PAGES as string[]).includes(first) ? (first as Page) : 'overview';
  return { page, id: page === 'incidents' && id ? decodeURIComponent(id) : undefined, query: new URLSearchParams(qs) };
}

function Shell() {
  const [hash, navigate] = useHash();
  const [reporting, setReporting] = useState(false);
  const [menu, setMenu] = useState(false);
  const { page, id, query } = route(hash);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('[aria-modal="true"]')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setReporting(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const report = () => setReporting(true);

  return (
    <div className="min-h-screen">
      <Sidebar page={page} open={menu} onClose={() => setMenu(false)} />
      <div className="min-w-0 lg:pl-60">
        <Topbar onMenu={() => setMenu(true)} onReport={report} />
        <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
          {id ? (
            <IncidentDetail key={id} id={id} navigate={navigate} />
          ) : page === 'incidents' ? (
            <Incidents query={query} navigate={navigate} />
          ) : page === 'services' ? (
            <Services />
          ) : page === 'repositories' ? (
            <Repositories />
          ) : page === 'approvals' ? (
            <Approvals query={query} navigate={navigate} />
          ) : page === 'audit' ? (
            <AuditLog />
          ) : page === 'settings' ? (
            <Settings />
          ) : (
            <Overview navigate={navigate} onReport={report} />
          )}
        </main>
      </div>

      {reporting && (
        <ReportIncidentDialog
          onClose={() => setReporting(false)}
          onCreated={(newId) => {
            setReporting(false);
            navigate(`#/incidents/${newId}`);
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <HealthProvider>
      <DataProvider>
        <FeedbackProvider>
          <Shell />
        </FeedbackProvider>
      </DataProvider>
    </HealthProvider>
  );
}
