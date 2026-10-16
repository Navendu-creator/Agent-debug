import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ITEM_SELECTOR = '[role=menuitem]:not([disabled]),[role=menuitemradio]:not([disabled]),[role=menuitemcheckbox]:not([disabled])';

/** Arrow keys / Home / End move focus between the items of an open menu. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown' ? (at + 1) % items.length
    : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
    : e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : -1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus();
}

/**
 * A button that opens a floating panel. The panel is portaled to <body> with fixed positioning, so
 * scrolling tables and overflow-hidden cards never clip it. Closes on outside click, Escape (focus
 * returns to the button) and page scroll; opens upwards when there is no room below.
 */
export function Popover({
  button,
  buttonClassName = 'btn-secondary',
  ariaLabel,
  title,
  align = 'right',
  panelClassName = 'w-56',
  disabled,
  role = 'menu',
  className = 'inline-flex',
  matchWidth,
  onOpenChange,
  children,
}: {
  button: ReactNode;
  buttonClassName?: string;
  ariaLabel?: string;
  title?: string;
  align?: 'left' | 'right';
  panelClassName?: string;
  disabled?: boolean;
  role?: 'menu' | 'dialog';
  /** Classes for the wrapper, e.g. `flex w-full` for a full-width button. */
  className?: string;
  /** Make the panel as wide as the button. */
  matchWidth?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const [up, setUp] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    onOpenChange?.(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify on open/close only
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    panel.current?.querySelector<HTMLElement>(`${ITEM_SELECTOR},[data-autofocus]`)?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const openUp = below < 300 && r.top > below;
      setUp(openUp);
      setStyle({
        position: 'fixed',
        ...(openUp ? { bottom: window.innerHeight - r.top + 8, maxHeight: r.top - 16 } : { top: r.bottom + 8, maxHeight: below - 16 }),
        ...(align === 'right' ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }),
        ...(matchWidth ? { width: r.width } : {}),
      });
    }
    setOpen((o) => !o);
  };

  return (
    <div className={`relative ${className}`}>
      <button
        ref={btn}
        type="button"
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={toggle}
        className={buttonClassName}
      >
        {button}
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panel}
            role={role}
            style={style}
            onKeyDown={moveFocus}
            className={`scrollbar-thin z-[80] max-w-[calc(100vw-1rem)] overflow-y-auto ${up ? 'origin-bottom' : 'origin-top'} animate-pop rounded-xl border border-edge-strong bg-panel-2 p-1 shadow-2xl shadow-black/60 ${matchWidth ? '' : panelClassName}`}
          >
            {typeof children === 'function' ? children(() => setOpen(false)) : children}
          </div>,
          document.body,
        )}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  description?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | 'separator' | { heading: string };

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted">{children}</div>;
}

/** Dropdown of actions. Falsy entries are skipped, so items can be listed conditionally. */
export function Menu({
  items,
  ...popover
}: Omit<Parameters<typeof Popover>[0], 'children' | 'role'> & { items: Array<MenuEntry | false | null | undefined> }) {
  // Hidden conditional items can leave separators at the edges or doubled up; drop those.
  const entries = items
    .filter((e): e is MenuEntry => Boolean(e))
    .filter((e, i, all) => e !== 'separator' || (i > 0 && i < all.length - 1 && all[i + 1] !== 'separator'));
  return (
    <Popover {...popover}>
      {(close) =>
        entries.map((e, i) => {
          if (e === 'separator') return <div key={i} role="separator" className="my-1 h-px bg-edge" />;
          if ('heading' in e) return <MenuHeading key={i}>{e.heading}</MenuHeading>;
          const Icon = e.icon;
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={e.disabled}
              onClick={() => {
                close();
                e.onSelect();
              }}
              className={`menu-item ${e.danger ? 'text-rose-300 hover:bg-rose-500/10 focus-visible:bg-rose-500/10' : ''}`}
            >
              {Icon && <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${e.danger ? 'text-rose-400' : 'text-fg-muted'}`} />}
              <span className="min-w-0 flex-1">
                <span className="block">{e.label}</span>
                {e.description && <span className="block text-[11px] leading-snug text-fg-muted">{e.description}</span>}
              </span>
              {e.hint && <kbd className="kbd">{e.hint}</kbd>}
            </button>
          );
        })
      }
    </Popover>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
}

/** Single-choice dropdown that shows the current choice on its button. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  prefix,
  ariaLabel,
  align = 'left',
  className = '',
  panelClassName = 'w-56',
  fullWidth,
}: {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  prefix?: ReactNode;
  ariaLabel: string;
  align?: 'left' | 'right';
  className?: string;
  panelClassName?: string;
  fullWidth?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Popover
      ariaLabel={ariaLabel}
      className={fullWidth ? 'flex w-full' : 'inline-flex'}
      matchWidth={fullWidth}
      align={align}
      panelClassName={panelClassName}
      buttonClassName={`btn-secondary h-9 justify-between gap-2 px-3 text-xs ${className}`}
      button={
        <>
          <span className="flex min-w-0 items-center gap-2">
            {prefix}
            {current?.icon}
            <span className="truncate">{current?.label ?? 'Select…'}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-fg-muted" />
        </>
      }
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={o.value === value}
            onClick={() => {
              onChange(o.value);
              close();
            }}
            className="menu-item"
          >
            {o.icon && <span className="mt-0.5 flex-shrink-0">{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{o.label}</span>
              {o.description && <span className="block truncate font-mono text-[11px] text-fg-muted">{o.description}</span>}
            </span>
            <Check className={`mt-0.5 h-4 w-4 flex-shrink-0 text-violet-300 ${o.value === value ? '' : 'invisible'}`} />
          </button>
        ))
      }
    </Popover>
  );
}

/** Multiple-choice dropdown (stays open while toggling). An empty selection means "all". */
export function MultiSelect<T extends string>({
  label,
  values,
  options,
  onChange,
  icon,
}: {
  label: string;
  values: T[];
  options: Array<SelectOption<T>>;
  onChange: (values: T[]) => void;
  icon?: ReactNode;
}) {
  const summary =
    values.length === 0 ? 'All' : values.length === 1 ? options.find((o) => o.value === values[0])?.label : `${values.length} selected`;
  return (
    <Popover
      ariaLabel={`${label} filter`}
      align="left"
      panelClassName="w-52"
      buttonClassName={`btn-secondary h-9 gap-2 px-3 text-xs ${values.length ? 'border-violet-500/50 text-violet-100' : ''}`}
      button={
        <>
          {icon}
          <span className="text-fg-muted">{label}:</span>
          <span>{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
        </>
      }
    >
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
            className="menu-item items-center"
          >
            <span
              className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${on ? 'border-violet-400 bg-violet-500 text-white' : 'border-edge-strong bg-panel'}`}
            >
              {on && <Check className="h-3 w-3" strokeWidth={3} />}
            </span>
            {o.icon}
            <span className="flex-1">{o.label}</span>
          </button>
        );
      })}
      {values.length > 0 && (
        <>
          <div className="my-1 h-px bg-edge" />
          <button type="button" role="menuitem" onClick={() => onChange([])} className="menu-item text-fg-muted">
            Clear filter
          </button>
        </>
      )}
    </Popover>
  );
}
