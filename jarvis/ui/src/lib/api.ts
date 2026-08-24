/** Client REST minimal de l'API JARVIS. */

import type {
  BusinessOrg, GoogleStatus, MemoryEntry, Overview, SystemInfo,
} from "./types";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchSystem(): Promise<SystemInfo> {
  return get<SystemInfo>("/api/system");
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  tool: string;
  decision: string;
  status: string;
  permission_level: number;
  duration_ms: number;
  result_summary: string;
}

export function fetchAudit(limit = 25): Promise<{ entries: AuditEntry[] }> {
  return get(`/api/audit?limit=${limit}`);
}

export interface MetricsSnapshot {
  turns: number;
  errors: number;
  latency_ms: { turn: { p50: number; p95: number; avg: number; count: number } };
  tools: { failure_rate: number };
  llm_spend: { spent_usd?: number; budget_usd?: number };
}

export function fetchMetrics(): Promise<MetricsSnapshot> {
  return get("/api/metrics");
}

// --- Integrations -----------------------------------------------------------

async function post<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { detail?: string }).detail ?? `${path}: ${response.status}`);
  }
  return payload as T;
}

export function fetchGoogleStatus(): Promise<GoogleStatus> {
  return get("/api/integrations/google/status");
}

/** Ouvre l'ecran de consentement Google dans un nouvel onglet. */
export async function connectGoogle(): Promise<void> {
  const { authorization_url } = await post<{ authorization_url: string }>(
    "/api/integrations/google/connect",
  );
  window.open(authorization_url, "_blank", "noopener,noreferrer");
}

export function disconnectGoogle(): Promise<{ disconnected: number }> {
  return post("/api/integrations/google/disconnect");
}

// --- Donnees du centre de commande ------------------------------------------

export function fetchOverview(): Promise<Overview> {
  return get("/api/overview");
}

export function fetchBusinesses(): Promise<{ organizations: BusinessOrg[]; note: string }> {
  return get("/api/businesses");
}

export interface MemoryResponse {
  enabled: boolean;
  memories: MemoryEntry[];
  kinds: Record<string, number>;
  total?: number;
}

export function fetchMemory(query = "", kind = ""): Promise<MemoryResponse> {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (kind) params.set("kind", kind);
  const suffix = params.toString();
  return get(`/api/memory${suffix ? `?${suffix}` : ""}`);
}

export async function forgetMemory(id: string): Promise<void> {
  const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`suppression refusee (${response.status})`);
}
