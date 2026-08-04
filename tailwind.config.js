/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './script.js'],
  theme: {
    extend: {
      colors: {
        gray: { 850: '#1f2937', 900: '#111827', 950: '#030712' },
      },
    },
  },
  plugins: [],
};
