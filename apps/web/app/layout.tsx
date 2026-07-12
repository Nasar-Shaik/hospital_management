import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediCore HMS",
  description: "PaperlessTech Hospital Management SaaS",
};

/**
 * Root layout. Route groups (public)/(portal)/(app) with their own nested
 * layouts land in P1 per Doc 04 §3.2 — Sprint 0 ships only the root shell.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
