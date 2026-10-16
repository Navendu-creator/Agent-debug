import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

// ---------- toasts ----------

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

const ToastContext = createContext<(toast: Omit<Toast, 'id'>) => void>(() => undefined);

/** `toast({ tone, title, description })` — a short notice in the corner that dismisses itself. */
export const useToast = () => useContext(ToastContext);

const TOAST_STYLE: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'text-emerald-400' },
  error: { icon: XCircle, cls: 'text-rose-400' },
  info: { icon: Info, cls: 'text-sky-400' },
};

// ---------- confirm dialog ----------

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `await confirm({ title, body, tone: 'danger' })` — resolves true when the user confirms. */
export const useConfirm = () => useContext(ConfirmContext);

function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const danger = options.tone === 'danger';

  useEffect(() => {
    // Destructive actions default to Cancel so Enter never deletes by accident.
    (danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [danger, onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md animate-pop overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-2xl shadow-black/60"
      >
        <div className="flex gap-4 p-6">
          <span
            className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${danger ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40' : 'bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/40'}`}
          >
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="confirm-title" className="font-display text-lg font-semibold text-fg">{options.title}</h2>
            {options.body && <div className="mt-1.5 space-y-2 text-sm text-fg-soft">{options.body}</div>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-edge bg-panel-2/60 px-6 py-4">
          <button ref={cancelRef} type="button" onClick={() => onClose(false)} className="btn-secondary">Cancel</button>
          <button ref={confirmRef} type="button" onClick={() => onClose(true)} className={danger ? 'btn-danger-solid' : 'btn-primary'}>
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- prompt dialog ----------

export interface PromptOptions {
  title: string;
  body?: ReactNode;
  label: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  required?: boolean;
  multiline?: boolean;
  /** Suggestions shown under the input (e.g. known owners). */
  suggestions?: string[];
}

const PromptContext = createContext<(options: PromptOptions) => Promise<string | null>>(async () => null);

/** `await prompt({ title, label })` — resolves the entered text, or null when cancelled. */
export const usePrompt = () => useContext(PromptContext);

function PromptDialog({ options, onClose }: { options: PromptOptions; onClose: (value: string | null) => void }) {
  const [value, setValue] = useState(options.initial ?? '');
  const danger = options.tone === 'danger';
  const invalid = options.required && !value.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid) onClose(value.trim());
  };
  const field = 'field mt-1.5';
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        className="w-full max-w-md animate-pop overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-2xl shadow-black/60"
      >
        <div className="p-6">
          <h2 id="prompt-title" className="font-display text-lg font-semibold text-fg">{options.title}</h2>
          {options.body && <div className="mt-1.5 space-y-2 text-sm text-fg-soft">{options.body}</div>}
          <label className="mt-4 block text-xs font-medium text-fg-soft">
            {options.label}
            {options.multiline ? (
              <textarea autoFocus rows={3} maxLength={500} value={value} onChange={(e) => setValue(e.target.value)} placeholder={options.placeholder} className={`${field} resize-y`} />
            ) : (
              <input autoFocus maxLength={60} value={value} onChange={(e) => setValue(e.target.value)} placeholder={options.placeholder} className={field} />
            )}
          </label>
          {options.suggestions && options.suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {options.suggestions.map((s) => (
                <button key={s} type="button" onClick={() => setValue(s)} className="rounded-full border border-edge bg-panel-2 px-2.5 py-0.5 text-xs text-fg-soft hover:border-edge-strong hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-edge bg-panel-2/60 px-6 py-4">
          <button type="button" onClick={() => onClose(null)} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={invalid} className={danger ? 'btn-danger-solid' : 'btn-primary'}>
            {options.confirmLabel ?? 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- provider ----------

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const [asking, setAsking] = useState<{ options: PromptOptions; resolve: (value: string | null) => void } | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ options, resolve })), []);
  const prompt = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => setAsking({ options, resolve })), []);
  const answer = useCallback(
    (value: string | null) => {
      asking?.resolve(value);
      setAsking(null);
    },
    [asking],
  );
  const close = useCallback(
    (ok: boolean) => {
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        <PromptContext.Provider value={prompt}>
          {children}
          {pending && <ConfirmDialog options={pending.options} onClose={close} />}
          {asking && <PromptDialog options={asking.options} onClose={answer} />}
          <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
            {toasts.map((t) => {
              const { icon: Icon, cls } = TOAST_STYLE[t.tone];
              return (
                <div
                  key={t.id}
                  role={t.tone === 'error' ? 'alert' : 'status'}
                  className="pointer-events-auto flex animate-toast items-start gap-3 rounded-xl border border-edge-strong bg-panel-2 p-3.5 shadow-2xl shadow-black/60"
                >
                  <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${cls}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">{t.title}</p>
                    {t.description && <p className="mt-0.5 break-words text-xs text-fg-muted">{t.description}</p>}
                  </div>
                  <button onClick={() => dismiss(t.id)} className="rounded p-0.5 text-fg-muted hover:text-fg" aria-label="Dismiss">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </PromptContext.Provider>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
