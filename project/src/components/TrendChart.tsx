import { useEffect, useMemo, useRef, useState } from 'react';
import type { IncidentSummary, Severity } from '@/lib/api';
import { SEVERITIES, SEVERITY_COLOR, SEVERITY_LABEL } from './ui';

const H = 210;
const PAD = { top: 10, right: 8, bottom: 26, left: 30 };
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4;

/** 1, 2, 5 × 10^k step so the axis shows ~4 clean ticks. */
function niceStep(max: number): number {
  const raw = Math.max(max, 4) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
}

/** Rect with only the top corners rounded (data end), square at the baseline side. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

interface Day {
  start: number;
  label: string;
  counts: Record<Severity, number>;
  total: number;
}

function buildDays(incidents: IncidentSummary[], days: number): Day[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out: Day[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const start = new Date(today);
    start.setDate(today.getDate() - d);
    out.push({
      start: start.getTime(),
      label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      total: 0,
    });
  }
  const first = out[0].start;
  for (const i of incidents) {
    const t = Date.parse(i.createdAt);
    if (t < first) continue;
    const day = [...out].reverse().find((d) => d.start <= t);
    if (!day) continue;
    day.counts[i.severity]++;
    day.total++;
  }
  return out;
}

/** Incidents reported per day, stacked by severity (critical at the baseline). */
export function TrendChart({ incidents, days }: { incidents: IncidentSummary[]; days: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [table]);

  const data = useMemo(() => buildDays(incidents, days), [incidents, days]);
  const max = Math.max(...data.map((d) => d.total), 0);
  const step = niceStep(max);
  const top = Math.max(step * Math.ceil(max / step), step * 2);
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  const plotW = width - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  const barW = Math.min(24, band * 0.55);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelEvery = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-soft" aria-label="Legend">
          {SEVERITIES.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SEVERITY_COLOR[s] }} />
              {SEVERITY_LABEL[s]}
            </li>
          ))}
        </ul>
        <button onClick={() => setTable((t) => !t)} aria-pressed={table} className="text-xs text-fg-muted hover:text-fg">
          {table ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {table ? (
        <div className="scrollbar-thin max-h-[210px] overflow-auto rounded-lg border border-edge">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel-2 text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Day</th>
                {SEVERITIES.map((s) => (
                  <th key={s} className="px-3 py-2 text-right font-medium">{SEVERITY_LABEL[s]}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge tabular-nums text-fg-soft">
              {[...data].reverse().map((d) => (
                <tr key={d.start}>
                  <td className="px-3 py-1.5">{d.label}</td>
                  {SEVERITIES.map((s) => (
                    <td key={s} className="px-3 py-1.5 text-right">{d.counts[s]}</td>
                  ))}
                  <td className="px-3 py-1.5 text-right font-medium text-fg">{d.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
          <svg width={width} height={H} role="img" aria-label={`Incidents per day for the last ${days} days, by severity`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="#1f2940" strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-fg-muted text-[10px] tabular-nums">
                  {t}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = PAD.left + band * i + band / 2;
              const x = cx - barW / 2;
              const present = SEVERITIES.filter((s) => d.counts[s] > 0);
              let acc = 0;
              return (
                <g key={d.start} opacity={hover === null || hover === i ? 1 : 0.45}>
                  {hover === i && <rect x={PAD.left + band * i + 2} y={PAD.top} width={band - 4} height={plotH} rx={6} fill="#ffffff" opacity={0.03} />}
                  {present.map((s, k) => {
                    const y0 = y(acc);
                    acc += d.counts[s];
                    const y1 = y(acc);
                    const last = k === present.length - 1;
                    const h = Math.max(1, y0 - y1 - (last ? 0 : GAP));
                    const yy = last ? y1 : y1 + GAP;
                    return last ? (
                      <path key={s} d={topRounded(x, yy, barW, h, RADIUS)} fill={SEVERITY_COLOR[s]} />
                    ) : (
                      <rect key={s} x={x} y={yy} width={barW} height={h} fill={SEVERITY_COLOR[s]} />
                    );
                  })}
                  {i % labelEvery === (data.length - 1) % labelEvery && (
                    <text x={cx} y={H - 8} textAnchor="middle" className="fill-fg-muted text-[10px]">
                      {d.label}
                    </text>
                  )}
                  {/* hit target: the whole band, not just the bar */}
                  <rect
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    tabIndex={0}
                    aria-label={`${d.label}: ${d.total} incidents`}
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute z-10 w-40 -translate-x-1/2 rounded-lg border border-edge-strong bg-panel-2 p-2.5 text-xs shadow-xl shadow-black/50"
              style={{ left: Math.min(Math.max(PAD.left + band * hover + band / 2, 80), width - 80), top: 0 }}
            >
              <p className="mb-1.5 flex justify-between font-medium text-fg">
                {data[hover].label} <span className="tabular-nums">{data[hover].total}</span>
              </p>
              {SEVERITIES.map((s) => (
                <p key={s} className="flex items-center gap-1.5 text-fg-soft">
                  <span className="h-2 w-2 rounded-sm" style={{ background: SEVERITY_COLOR[s] }} />
                  <span className="flex-1">{SEVERITY_LABEL[s]}</span>
                  <span className="tabular-nums text-fg">{data[hover].counts[s]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
