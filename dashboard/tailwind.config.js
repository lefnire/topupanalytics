/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class", // Enable class-based dark mode
  content: [
    "./app/**/*.{js,ts,jsx,tsx}", // Keep existing paths
    // Ensure Shadcn UI components path is covered if different, e.g.:
    "./app/components/ui/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: { // Standard Shadcn container settings
    },
    extend: {
    },
  },
  plugins: [
  ],
}