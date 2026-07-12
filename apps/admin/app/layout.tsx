import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediCore Admin Console",
  description: "PaperlessTech HMS — SaaS operator console",
};

/** Super-admin console shell (Doc 04 §3.4). */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
