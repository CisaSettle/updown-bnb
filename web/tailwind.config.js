/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        up: {
          DEFAULT: '#0f9d58',
          soft: '#e6f6ed',
          softdark: '#0d2b1d',
        },
        down: {
          DEFAULT: '#d93025',
          soft: '#fdeceb',
          softdark: '#331312',
        },
        brand: {
          DEFAULT: '#f0b90b',
          dark: '#c99400',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        pop: { '0%': { transform: 'scale(0.96)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
        pop: 'pop 140ms ease-out',
      },
    },
  },
  plugins: [],
}
