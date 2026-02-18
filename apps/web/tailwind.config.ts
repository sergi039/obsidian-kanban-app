import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        board: {
          bg: 'var(--board-bg)',
          column: 'var(--board-column)',
          card: 'var(--board-card)',
          'card-hover': 'var(--board-card-hover)',
          border: 'var(--board-border)',
          'border-hover': 'var(--board-border-hover)',
          text: 'var(--board-text)',
          'text-muted': 'var(--board-text-muted)',
          accent: 'var(--board-accent)',
        },
        priority: {
          high: '#d29922',
          urgent: '#f85149',
        },
      },
    },
  },
  plugins: [],
};

export default config;
