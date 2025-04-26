/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}", // Assuming components might be in a top-level 'components' dir later
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}