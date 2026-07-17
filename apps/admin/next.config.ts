import type { NextConfig } from "next";

/**
 * Doc 04 §6.2: standalone output → slim Node runtime container.
 * ADR-0012: this app is presentation-tier only — no business logic here.
 */
const nextConfig: NextConfig = {
  /**
   * `next dev` and `next build` both write here, and by default to the SAME
   * directory. Run a production build while the dev server is up and the build
   * replaces the chunks the dev server has open — the browser then dies on
   * "Cannot find module './963.js'", a Webpack chunk nobody ever wrote. It looks
   * like a code failure and is not one.
   *
   * So DEV gets its own directory (`.next-dev`, set by the dev script) while
   * build and start keep the default `.next`. Production and Docker are
   * untouched, and the two can no longer overwrite each other — nobody has to
   * remember not to run a build in another terminal.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  eslint: { ignoreDuringBuilds: true }, // linting runs via turbo `lint`, not inside next build
  poweredByHeader: false,
};

export default nextConfig;
