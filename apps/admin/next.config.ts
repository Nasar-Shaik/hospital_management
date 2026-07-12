import type { NextConfig } from "next";

/**
 * Doc 04 §6.2: standalone output → slim Node runtime container.
 * ADR-0012: this app is presentation-tier only — no business logic here.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  eslint: { ignoreDuringBuilds: true }, // linting runs via turbo `lint`, not inside next build
  poweredByHeader: false,
};

export default nextConfig;
