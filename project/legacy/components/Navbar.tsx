import { useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';

const navItems = [
  { href: '#report', label: 'Report' },
  { href: '#architecture', label: 'Architecture' },
  { href: '#workflow', label: 'Workflow' },
  { href: '#tech', label: 'Tech' },
  { href: '#demo', label: 'Demo' },
  { href: '#roadmap', label: 'Roadmap' },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-paper/85 backdrop-blur-md border-b border-line'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="#" className="font-display text-lg font-bold tracking-tight text-ink">
          Debug<span className="text-teal">Assist</span>
        </a>

        <div className="hidden md:flex items-center gap-1">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="px-3 py-2 text-sm text-ink-muted hover:text-ink transition-colors"
            >
              {item.label}
            </a>
          ))}
          <a
            href="#report"
            className="ml-3 px-4 py-2 rounded-md bg-ink text-paper text-sm font-medium hover:bg-ink/90 transition-colors"
          >
            Report error
          </a>
        </div>

        <button
          onClick={() => setOpen(!open)}
          className="md:hidden text-ink-soft"
          aria-label="Toggle menu"
        >
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {open && (
        <div className="md:hidden bg-paper border-b border-line">
          <div className="px-6 py-4 space-y-1">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="block px-3 py-3 text-ink-soft hover:text-ink transition-colors"
              >
                {item.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
