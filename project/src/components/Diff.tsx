import { useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { Incident } from '@/lib/api';
import { copyText } from '@/lib/format';
import { useToast } from './feedback';

type Change = NonNullable<Incident['remediation']>['changes'][number];

/** +added / −removed line counts of a unified diff. */
export function diffStats(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n');
  return {
    added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  };
}

export function DiffView({ diff, className = 'max-h-96' }: { diff: string; className?: string }) {
  const lines = diff.split('\n').filter((l) => !/^(Index:|={10,})/.test(l));
  return (
    <pre className={`scrollbar-thin overflow-auto bg-black/40 py-2 font-mono text-xs ${className}`}>
      {lines.map((l, i) => (
        <div
          key={i}
          className={`whitespace-pre px-4 ${
            l.startsWith('+++') || l.startsWith('---')
              ? 'text-fg-muted'
              : l.startsWith('+')
                ? 'bg-emerald-500/10 text-emerald-300'
                : l.startsWith('-')
                  ? 'bg-rose-500/10 text-rose-300'
                  : l.startsWith('@@')
                    ? 'bg-sky-500/10 text-sky-300'
                    : 'text-fg-soft'
          }`}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

export function FileDiffBlock({ change, defaultOpen }: { change: Change; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const toast = useToast();
  const { added, removed } = diffStats(change.diff);
  return (
    <div className="overflow-hidden rounded-xl border border-edge">
      <div className="flex items-center gap-2 bg-panel-2/70 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={`h-4 w-4 flex-shrink-0 text-fg-muted transition ${open ? 'rotate-90' : ''}`} />
          <span className="truncate font-mono text-sm text-fg">{change.path}</span>
          <span className="flex-shrink-0 font-mono text-[11px]">
            <span className="text-emerald-400">+{added}</span> <span className="text-rose-400">−{removed}</span>
          </span>
          <span className="hidden truncate text-xs text-fg-muted sm:inline">{change.description}</span>
        </button>
        <button
          onClick={() =>
            void copyText(change.diff).then(
              () => toast({ tone: 'success', title: 'Diff copied' }),
              () => toast({ tone: 'error', title: 'Copy failed' }),
            )
          }
          className="btn-icon h-7 w-7"
          aria-label={`Copy diff of ${change.path}`}
          title="Copy diff"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="border-t border-edge">
          <DiffView diff={change.diff} />
        </div>
      )}
    </div>
  );
}

