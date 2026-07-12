/**
 * Isomorphic typed API client (ADR-0012: server components and client
 * components both call Express through this — Next.js never fetches data
 * any other way). Module-specific methods are added per phase.
 */
import type { ApiEnvelope, HealthStatus, ReadinessStatus } from "@medicore/types";

export interface ApiClientOptions {
  baseUrl: string;
  /** Called before each request; returns headers (auth is wired in P1). */
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getHeaders?: ApiClientOptions["getHeaders"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.getHeaders = options.getHeaders;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.getHeaders ? await this.getHeaders() : {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = (await res.json()) as ApiEnvelope<T>;
    if (!res.ok || !envelope.success) {
      const err = envelope.error;
      throw new ApiClientError(
        res.status,
        err?.code ?? "HMS-GEN-500",
        err?.message ?? "Request failed",
        err?.traceId,
      );
    }
    return envelope.data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** Liveness of the API service. */
  health(): Promise<HealthStatus> {
    return this.get<HealthStatus>("/health");
  }

  /** Readiness (dependencies reachable). */
  ready(): Promise<ReadinessStatus> {
    return this.get<ReadinessStatus>("/ready");
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
