import { useState, useEffect } from 'react';
import { ArrowRight } from 'lucide-react';

const FEED_TEXT = [
  'INC-00042  payment-api CrashLoopBackOff',
  '→ collecting k8s events + recent deploys',
  '→ root cause: unbounded cache after v1.4.2',
  '→ fix validated · PR ready for review',
].join('\n');

export function Hero() {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      if (i <= FEED_TEXT.length) {
        setTyped(FEED_TEXT.slice(0, i));
        i++;
      } else {
        clearInterval(interval);
      }
    }, 28);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative min-h-screen overflow-hidden">
      {/* Atmosphere */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 60% at 70% 20%, rgba(0,168,150,0.14), transparent 55%), radial-gradient(ellipse 50% 40% at 10% 80%, rgba(232,93,76,0.08), transparent 50%), linear-gradient(180deg, #f7fafc 0%, #eef3f8 55%, #e8eef5 100%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.35] animate-drift"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(12,18,34,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(12,18,34,0.06) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent)',
        }}
      />

      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-28 pb-16 md:pt-36 md:pb-24">
        <div className="max-w-3xl animate-fade-up">
          <p className="font-display text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight text-ink leading-[0.95] mb-6">
            Debug<span className="text-teal">Assist</span>
          </p>
          <h1 className="font-display text-2xl sm:text-3xl md:text-4xl font-semibold text-ink tracking-tight text-balance mb-4">
            From alert to pull request — automatically.
          </h1>
          <p className="text-lg text-ink-soft max-w-xl mb-8 leading-relaxed">
            An AI agent that investigates production incidents, proves the root cause with evidence, writes a fix, and opens the PR.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="#report"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md bg-teal text-white font-semibold hover:bg-teal-deep transition-colors"
            >
              Report an error
              <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#architecture"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-ink font-semibold border border-line bg-paper/70 hover:bg-paper transition-colors"
            >
              How it&apos;s built
            </a>
          </div>
        </div>
      </div>

      {/* Dominant visual plane — full-bleed investigation feed */}
      <div className="relative z-10 w-full border-t border-line/80">
        <div
          className="relative overflow-hidden"
          style={{
            background:
              'linear-gradient(180deg, #0c1222 0%, #121a2b 100%)',
          }}
        >
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal/60 to-transparent" />
          <div className="absolute right-0 top-0 bottom-0 w-1/3 opacity-40 pointer-events-none">
            <div className="absolute inset-0 bg-gradient-to-l from-teal/20 to-transparent" />
            <div className="absolute inset-0 overflow-hidden">
              <div className="w-full h-16 bg-gradient-to-b from-teal/25 to-transparent animate-scan" />
            </div>
          </div>

          <div className="max-w-6xl mx-auto px-6 py-10 md:py-14">
            <div className="flex items-center justify-between mb-6 gap-4">
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-teal animate-pulse-soft" />
                <span className="font-mono text-xs text-white/50 tracking-wider uppercase">
                  Live investigation feed
                </span>
              </div>
              <span className="font-mono text-xs text-teal">confidence 94%</span>
            </div>
            <pre className="font-mono text-sm md:text-base leading-relaxed text-white/85 whitespace-pre-wrap min-h-[7.5rem]">
              {typed}
              <span className="text-teal animate-blink">▍</span>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
