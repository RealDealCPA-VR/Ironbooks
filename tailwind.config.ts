import type { Config } from "tailwindcss";

/** A theme color: an RGB-channel CSS variable from app/globals.css, opacity modifiers included. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const scale = (name: string) => Object.fromEntries(SHADES.map((s) => [s, v(`${name}-${s}`)]));

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Canonical brand palette — SINGLE source of truth. The names are historical: they now
        // read the theme variables in app/globals.css (light / dark / auto + accent color), so
        // `text-navy` is "primary text" and `text-electric` is "the accent color" in every theme.
        navy: v("ink"),
        electric: v("accent"),
        emerald: v("success"),
        gold: v("gold"),
        offwhite: v("canvas"),
        chrome: v("chrome"),
        /** A dark fill that keeps white text readable in both themes (tooltips, dark chips). */
        contrast: v("contrast"),
        surface: v("surface"),
        slate: scale("slate"),
        red: scale("red"),
        amber: scale("amber"),
        yellow: scale("yellow"),
      },
      // `bg-white` means "a card or field surface": white in light mode, dark gray in dark mode.
      // text-white / border-white / ring-white stay true white.
      backgroundColor: {
        white: v("surface"),
      },
      fontFamily: {
        // Inter is self-hosted via next/font (app/layout.tsx sets --font-inter); the Apple system
        // font is preferred where it exists.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "var(--font-inter)",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      boxShadow: {
        // Theme-aware soft shadows (app/globals.css): lighter in light mode, deeper in dark.
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        "2xl": "var(--shadow-2xl)",
      },
      // The desktop title bar sits above the page, so "full screen height" means below it.
      height: {
        screen: "calc(100vh - var(--titlebar-h, 0px))",
      },
      minHeight: {
        screen: "calc(100vh - var(--titlebar-h, 0px))",
      },
      maxHeight: {
        screen: "calc(100vh - var(--titlebar-h, 0px))",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
