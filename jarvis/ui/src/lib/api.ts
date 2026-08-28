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

/** Import par collage: le plus court chemin quand produire un export est penible. */
export async function pasteBusinessData(
  orgId: string,
  content: string,
): Promise<BusinessImportReport> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(orgId)}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, name: "colle" }),
  });
  const payload = await response.json().catch(() => ({ detail: "" }));
  if (!response.ok) {
    throw new Error(payload.detail || `import refuse (${response.status})`);
  }
  return payload.report;
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

export interface JarvisAlert {
  id: string;
  kind: string;
  severity: "info" | "attention";
  title: string;
  detail: string;
  source: string;
  created_at: string;
  seen: boolean;
}

export interface ScheduledJob {
  name: string;
  schedule: string;
  next_run: string;
  last_run: string;
  runs: number;
  failures: number;
  last_error: string;
}

export interface AlertsResponse {
  /** Faux = surveillance eteinte. A distinguer d'une liste vide. */
  enabled: boolean;
  alerts: JarvisAlert[];
  schedule: ScheduledJob[];
}

export function fetchAlerts(): Promise<AlertsResponse> {
  return get("/api/alerts");
}

export async function dismissAlerts(): Promise<void> {
  await fetch("/api/alerts", { method: "DELETE" });
}

export async function markAlertSeen(id: string): Promise<void> {
  await fetch(`/api/alerts/${encodeURIComponent(id)}/seen`, { method: "POST" });
}

export interface Briefing {
  day: string;
  text: string;
  sources: string[];
  created_at: string;
}

export function fetchBriefing(): Promise<{ briefing: Briefing | null; scheduled_at: string }> {
  return get("/api/briefing");
}

export async function generateBriefing(): Promise<Briefing> {
  const response = await fetch("/api/briefing", { method: "POST" });
  const payload = await response.json().catch(() => ({ detail: "" }));
  if (!response.ok) throw new Error(payload.detail || "briefing impossible");
  return payload.briefing;
}

export const ORG_KINDS = [
  { value: "restaurant", label: "Restaurant" },
  { value: "saas", label: "Logiciel / SaaS" },
  { value: "realestate", label: "Immobilier" },
  { value: "other", label: "Autre" },
] as const;

export async function createOrganization(name: string, kind: string): Promise<void> {
  const response = await fetch("/api/businesses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, kind }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "" }));
    throw new Error(payload.detail || "creation refusee");
  }
}

export async function renameOrganization(
  id: string,
  name: string,
  kind: string,
): Promise<void> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, kind }),
  });
  if (!response.ok) throw new Error("modification refusee");
}

/** Archive par defaut: les chiffres sont conserves et l'entreprise restaurable. */
export async function archiveOrganization(id: string): Promise<void> {
  const response = await fetch(`/api/businesses/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "" }));
    throw new Error(payload.detail || "retrait refuse");
  }
}

export interface UpdateStatus {
  available: boolean;
  behind: number;
  clean: boolean;
  current: string;
  branch: string;
  changes: string[];
  error: string;
  /** Raison pour laquelle la mise a jour est impossible, s'il y en a une. */
  blocked: string;
}

export function checkForUpdate(): Promise<UpdateStatus> {
  return get("/api/settings/update");
}

export interface UpdateResult {
  updated: boolean;
  restarted: boolean;
  detail: string;
  error: string;
}

export async function installUpdate(): Promise<UpdateResult> {
  const response = await fetch("/api/settings/update", { method: "POST" });
  if (!response.ok) throw new Error(`mise a jour refusee (${response.status})`);
  return response.json();
}

// ------------------------------------------------------------------ la voix

export interface VoiceChoice {
  id: string;
  label: string;
  locale: string;
  gender: string;
  /** Generation recente: nettement plus naturelle. */
  modern: boolean;
  /** Voix anglaise qui prononcera le francais avec son accent. */
  british: boolean;
}

export interface DeliveryChoice {
  key: string;
  label: string;
  description: string;
  rate: string;
  pitch: string;
}

export interface VoiceConfig {
  provider: string;
  voices: VoiceChoice[];
  deliveries: DeliveryChoice[];
  /** Voix choisie explicitement, ou chaine vide si c'est automatique. */
  voice: string;
  /** Voix reellement utilisee, y compris quand le choix est automatique. */
  resolved: string;
  delivery: string;
  address: string;
  accent: string;
  error: string;
}

export function readVoiceConfig(): Promise<VoiceConfig> {
  return get("/api/settings/voice");
}

export interface VoiceChange {
  voice?: string;
  delivery?: string;
  address?: string;
  accent?: string;
}

export async function saveVoice(change: VoiceChange): Promise<{ saved: boolean }> {
  const response = await fetch("/api/settings/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error(`choix refuse (${response.status})`);
  return response.json();
}

/** Fait entendre une phrase sans rien enregistrer: comparer avant de choisir. */
export async function testVoice(change: VoiceChange): Promise<{ audio: string; mime: string }> {
  const response = await fetch("/api/settings/voice/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? `essai impossible (${response.status})`);
  }
  return response.json();
}

// ------------------------------------ rapports business recus par courriel

export interface MailRule {
  id: string;
  org_id: string;
  sender: string;
  subject: string;
  label: string;
  enabled: boolean;
  last_run_at: string;
}

export interface MailRulesResponse {
  rules: MailRule[];
  /** Raison pour laquelle rien ne peut fonctionner, s'il y en a une. */
  blocked: string;
}

export function fetchMailRules(): Promise<MailRulesResponse> {
  return get("/api/business/mail-rules");
}

export async function addMailRule(rule: {
  org_id: string;
  sender: string;
  subject?: string;
  label?: string;
}): Promise<void> {
  const response = await fetch("/api/business/mail-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? `ajout refuse (${response.status})`);
  }
}

export async function removeMailRule(ruleId: string): Promise<void> {
  const response = await fetch(`/api/business/mail-rules/${ruleId}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`suppression refusee (${response.status})`);
}

export interface MailScanReport {
  imported: string[];
  already_seen: number;
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
  rows: number;
  error: string;
  summary: string;
}

export async function scanMailNow(): Promise<MailScanReport> {
  const response = await fetch("/api/business/mail-rules/scan", { method: "POST" });
  if (!response.ok) throw new Error(`recherche impossible (${response.status})`);
  return response.json();
}

// --------------------------------- dossiers designes (export d'une caisse)

export interface FolderSource {
  id: string;
  org_id: string;
  path: string;
  pattern: string;
  label: string;
  enabled: boolean;
  last_run_at: string;
  last_error: string;
}

export interface FolderSourcesResponse {
  sources: FolderSource[];
  blocked: string;
}

export function fetchFolderSources(): Promise<FolderSourcesResponse> {
  return get("/api/business/folders");
}

export async function addFolderSource(source: {
  org_id: string;
  path: string;
  pattern?: string;
  label?: string;
}): Promise<{ reachable: boolean; warning: string }> {
  const response = await fetch("/api/business/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? `ajout refuse (${response.status})`);
  }
  return response.json();
}

export async function removeFolderSource(sourceId: string): Promise<void> {
  const response = await fetch(`/api/business/folders/${sourceId}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`suppression refusee (${response.status})`);
}

export interface FolderScanReport {
  imported: string[];
  unchanged: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
  rows: number;
  summary: string;
}

export async function scanFoldersNow(): Promise<FolderScanReport> {
  const response = await fetch("/api/business/folders/scan", { method: "POST" });
  if (!response.ok) throw new Error(`lecture impossible (${response.status})`);
  return response.json();
}

export interface FolderCandidate {
  path: string;
  sample: string;
  columns: string[];
  files: number;
  newest: string;
}

export interface DiscoveryReport {
  candidates: FolderCandidate[];
  roots: string[];
  scanned: number;
  truncated: boolean;
  seconds: number;
  summary: string;
}

/** Cherche les dossiers de rapports sur la machine. Lecture seule. */
export async function discoverFolders(): Promise<DiscoveryReport> {
  const response = await fetch("/api/business/folders/discover", { method: "POST" });
  if (!response.ok) throw new Error(`recherche impossible (${response.status})`);
  return response.json();
}
