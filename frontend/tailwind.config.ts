import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#FAFAF7',
        primary: '#1A1A1A',
        accent: '#C2410C',
        secondary: '#6B6B6B',
        border: '#E5E5E5',
        success: '#15803D',
        error: '#DC2626',
        background: 'var(--background)',
        primary: 'var(--primary)',
        accent: 'var(--accent)',
        secondary: 'var(--secondary)',
        border: 'var(--border)',
        success: '#22C55E',
        error: '#EF4444',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
};

export default config;
