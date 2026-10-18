import "./globals.css";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui";
import AppShell from "@/components/AppShell";
import DesktopBridge from "@/components/DesktopBridge";
import SandboxBanner from "@/components/SandboxBanner";
import ClosingPasswordProvider from "@/components/ClosingPasswordProvider";
import WindowTitleBar from "@/components/WindowTitleBar";
import { ThemeSync } from "@/lib/useTheme";
import { DEFAULT_THEME, THEME_BOOT_SCRIPT } from "@/lib/theme";

// Self-hosted via next/font: the woff2 is downloaded at BUILD time and served from the app
// bundle, so the offline desktop app never phones Google Fonts at runtime.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "600", "700", "900"],
  variable: "--font-inter",
});

export const metadata = {
  title: "Ironbooks",
  description: "Open-source desktop accounting with AI error correction.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme / data-accent / data-desktop are set from the theme cookie before the first paint
    // (THEME_BOOT_SCRIPT), so they can differ from the server's defaults by design.
    <html
      lang="en"
      className={inter.variable}
      data-theme={DEFAULT_THEME.mode}
      data-accent={DEFAULT_THEME.accent}
      suppressHydrationWarning
    >
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta charSet="UTF-8" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="bg-offwhite font-sans antialiased min-h-screen">
        <WindowTitleBar />
        <ThemeSync />
        <DesktopBridge />
        <SandboxBanner />
        <AppShell>{children}</AppShell>
        <Toaster />
        <ClosingPasswordProvider />
      </body>
    </html>
  );
}
