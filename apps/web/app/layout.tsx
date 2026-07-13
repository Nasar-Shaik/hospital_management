import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "../components/AuthProvider";
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
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
