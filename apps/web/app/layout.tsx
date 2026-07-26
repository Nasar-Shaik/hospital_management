import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider, themeInitScript } from "@medicore/ui";
import { AuthProvider } from "../components/AuthProvider";
import { BranchProvider } from "../components/BranchProvider";
import { IdleGuard } from "../components/IdleGuard";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediCore HMS",
  description: "PaperlessTech Hospital Management SaaS",
};

/**
 * Root layout (Doc 04 §3.2).
 *
 * `AuthProvider` wraps everything, /login included: the login page needs the same
 * session machinery to CREATE a session that the rest of the app uses to CONSUME
 * one. Splitting them would mean two implementations of the token lifecycle.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /**
     * `suppressHydrationWarning` is required and is NOT papering over a bug. The
     * inline script below deliberately mutates <html> before React hydrates — that
     * is the entire point of it — so the server's markup and the client's DOM are
     * *supposed* to differ on this one element. Without the suppression React
     * screams about the difference it was asked to allow. It is scoped to <html>
     * only; a genuine hydration mismatch anywhere inside still reports.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before the first paint — stops the white flash. See packages/ui/src/theme.tsx. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <AuthProvider>
            <BranchProvider>
              <IdleGuard />
              {children}
            </BranchProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
