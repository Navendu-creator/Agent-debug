/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Nagent dark theme
        base: '#070b14',
        panel: {
          DEFAULT: '#0d1322',
          2: '#131b2e',
          3: '#1a2338',
        },
        edge: {
          DEFAULT: '#1f2940',
          strong: '#2c3954',
        },
        fg: {
          DEFAULT: '#e8edf7',
          soft: '#b6c0d4',
          muted: '#7d89a3',
        },
        brand: {
          violet: '#8b5cf6',
          cyan: '#22d3ee',
        },
      },
      fontFamily: {
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
        body: ['DM Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 24px 48px -24px rgba(0,0,0,0.7)',
        glow: '0 10px 30px -10px rgba(139,92,246,0.55)',
      },
      keyframes: {
        shimmer: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(250%)' } },
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pop: { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
        toast: { from: { opacity: '0', transform: 'translateY(12px) scale(0.98)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        'fade-up': 'fade-up 0.35s ease-out both',
        pop: 'pop 0.14s ease-out both',
        toast: 'toast 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
      },
    },
  },
  plugins: [],
};
