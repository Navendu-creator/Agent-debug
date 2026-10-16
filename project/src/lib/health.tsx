import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Health, type RepoTarget } from './api';

export interface Repository {
  id: RepoTarget;
  provider: 'github' | 'gitlab';
  name: string;
  baseBranch: string | null;
  webUrl: string | null;
  /** Paths Nagent may edit ("*" = whole repository). */
  allowedPaths?: string[];
  isDefault: boolean;
}

interface HealthState {
  health: Health | null;
  /** The backend did not answer the last check. */
  down: boolean;
  checkedAt: number | null;
  refresh: () => void;
}

const HealthContext = createContext<HealthState>({ health: null, down: false, checkedAt: null, refresh: () => undefined });

/** One poll of /api/health shared by the header, the incident list and the report dialog. */
export function HealthProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const refresh = useCallback(() => {
    api.health().then(
      (h) => {
        setHealth(h);
        setDown(false);
        setCheckedAt(Date.now());
      },
      () => {
        setDown(true);
        setCheckedAt(Date.now());
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  return <HealthContext.Provider value={{ health, down, checkedAt, refresh }}>{children}</HealthContext.Provider>;
}

export const useHealth = () => useContext(HealthContext);

/** Real repositories incidents can be investigated against (none in mock mode or when unconfigured). */
export function repositories(health: Health | null): Repository[] {
  if (!health || health.github.mode === 'mock') return [];
  return (health.repos ?? [])
    .filter((r): r is typeof r & { provider: 'github' | 'gitlab' } => r.provider === 'github' || r.provider === 'gitlab')
    .map((r) => ({ ...r, isDefault: r.id === health.defaultRepo }));
}

/** True when the configured model can run analyses right now. */
export function aiReady(health: Health | null): boolean {
  return Boolean(health && !health.ai.demoMode && health.ai.reachable && health.ai.modelAvailable);
}
