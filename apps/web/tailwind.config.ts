import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        board: {
          bg: '#0d1117',
          column: '#161b22',
          card: '#1c2128',
          'card-hover': '#242a33',
          border: '#30363d',
          'border-hover': '#484f58',
          text: '#e6edf3',
          'text-muted': '#7d8590',
          accent: '#58a6ff',
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
