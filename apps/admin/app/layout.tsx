import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider, themeInitScript } from "@medicore/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediCore Admin Console",
  description: "PaperlessTech HMS — SaaS operator console",
};

// Same faces as the hospital app, so the two products read as one company's work.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

/** Super-admin console shell (Doc 04 §3.4). Same theme machinery as the hospital app. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // See apps/web/app/layout.tsx for why this suppression is required, not a smell.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
