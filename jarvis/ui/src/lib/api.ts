/** Client REST minimal de l'API JARVIS. */

import type {
  BusinessImport, BusinessOrg, DocumentEntry, DocumentHit, GoogleStatus, MemoryEntry,
  Overview, PaneStatus, SystemInfo,
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

export interface BusinessesResponse {
  enabled: boolean;
  organizations: BusinessOrg[];
  period: { days: number; start: string; end: string };
  imports?: BusinessImport[];
  note: string;
}

export function fetchBusinesses(days = 7): Promise<BusinessesResponse> {
  return get(`/api/businesses?days=${days}`);
}

export interface BusinessImportReport {
  facts: number;
  rows_ok: number;
  rows_failed: number;
  metrics: string[];
  ignored_columns: string[];
  errors: { line: number; reason: string }[];
  first_day: string;
  last_day: string;
  summary: string;
}

export async function importBusinessCsv(
  orgId: string,
  file: File,
): Promise<BusinessImportReport> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`/api/businesses/${encodeURIComponent(orgId)}/import`, {
    method: "POST",
    body,
  });
  const payload = await response.json().catch(() => ({ detail: "" }));
  if (!response.ok) {
    throw new Error(payload.detail || `import refuse (${response.status})`);
  }
  return payload.report;
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

export interface DocumentsResponse {
  enabled: boolean;
  status: PaneStatus;
  detail: string;
  documents: DocumentEntry[];
  hits?: DocumentHit[];
  total: number;
  /** Ce que la recherche sait reellement faire: « lexical », « semantique ». */
  search_modes: string[];
  documents_dir?: string;
}

export function fetchDocuments(query = ""): Promise<DocumentsResponse> {
  const suffix = query ? `?query=${encodeURIComponent(query)}` : "";
  return get(`/api/documents${suffix}`);
}

export async function forgetDocument(id: string): Promise<void> {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`suppression refusee (${response.status})`);
}

export interface ReindexResponse {
  summary: string;
  total: number;
  report: {
    indexed: string[];
    unchanged: string[];
    skipped: { name: string; reason: string }[];
    failed: { name: string; reason: string }[];
    chunks: number;
  };
}

export async function reindexDocuments(): Promise<ReindexResponse> {
  const response = await fetch("/api/documents/reindex", { method: "POST" });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: "" }));
    throw new Error(detail.detail || `indexation refusee (${response.status})`);
  }
  return response.json();
}

export interface FeatureToggle {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  /** Vrai si activer demande de reconnecter un compte externe. */
  needs_reconnect: boolean;
}

export interface SettingsResponse {
  features: FeatureToggle[];
  documents_dir: string;
  timezone: string;
  /** Presence seulement — la valeur d'une cle ne transite jamais. */
  anthropic_key_present: boolean;
  google_configured: boolean;
}

export function fetchSettings(): Promise<SettingsResponse> {
  return get("/api/settings");
}

export interface SettingsPatchResult {
  changed: string[];
  restart_needed: boolean;
  reconnect_google: boolean;
}

export async function updateSettings(patch: {
  features?: Record<string, boolean>;
  documents_dir?: string;
}): Promise<SettingsPatchResult> {
  const response = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = await response.json().catch(() => ({ detail: "" }));
  if (!response.ok) {
    throw new Error(payload.detail || `modification refusee (${response.status})`);
  }
  return payload;
}
