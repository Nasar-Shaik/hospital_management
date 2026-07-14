import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider, themeInitScript } from "@medicore/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediCore Admin Console",
  description: "PaperlessTech HMS — SaaS operator console",
};

/** Super-admin console shell (Doc 04 §3.4). Same theme machinery as the hospital app. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // See apps/web/app/layout.tsx for why this suppression is required, not a smell.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
