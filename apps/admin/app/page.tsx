import { createApiClient } from "@medicore/api-client";

/** Server component; request-time render (see apps/web/app/page.tsx). */
export const dynamic = "force-dynamic";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4000";

async function getApiStatus(): Promise<string> {
  try {
    const api = createApiClient({ baseUrl: API_BASE_URL });
    const ready = await api.ready();
    return `API ${ready.status} — checks: ${JSON.stringify(ready.checks)}`;
  } catch {
    return "API unreachable";
  }
}

export default async function AdminHomePage() {
  const apiStatus = await getApiStatus();
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "var(--space-6)",
      }}
    >
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-8)",
          maxWidth: 560,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: "var(--space-2)" }}>
          Admin Console
        </h1>
        <p style={{ color: "var(--color-fg-muted)", marginBottom: "var(--space-4)" }}>
          Sprint 0 bootstrap — SaaS operator surface. Tenant provisioning arrives in Phase 1.
        </p>
        <p style={{ fontFamily: "monospace", fontSize: 14 }}>{apiStatus}</p>
      </div>
    </main>
  );
}
