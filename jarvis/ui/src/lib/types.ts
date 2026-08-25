/** Types partages avec l'API Python (voir jarvis_core/orchestrator/events.py). */

export type AssistantState =
  | "idle"
  | "listening"
  | "transcribing"
  | "understanding"
  | "working"
  | "speaking";

export interface Citation {
  label: string;
  kind: string;
  locator: string;
  url: string;
  timestamp: string;
}

export interface PendingAction {
  action_id: string;
  tool: string;
  description: string;
  permission_level: number;
}

export interface ToolActivity {
  id: string;
  tool: string;
  label: string;
  status: "running" | "ok" | "failed";
  summary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  streaming?: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  permission: number;
  available: boolean;
  feature_flag: string;
}

export interface GoogleStatus {
  connected: boolean;
  configured: boolean;
  accounts: string[];
  account?: string;
  scopes?: string[];
  expired?: boolean;
  requested_scopes: string[];
  redirect_uri: string;
  features: { gmail: boolean; calendar: boolean; drive?: boolean };
}

export interface SystemInfo {
  name: string;
  user: string;
  language: string;
  timezone: string;
  env: string;
  dry_run: boolean;
  features: Record<string, boolean>;
  providers: {
    llm: string;
    llm_models: { fast: string; balanced: string; deep: string };
    stt: string;
    stt_available: boolean;
    tts: string;
    tts_available: boolean;
  };
  tools: ToolInfo[];
  auto_approve_max_level: number;
  integrations: { google: GoogleStatus };
}

/** Evenement recu du serveur. */
export interface ServerEvent {
  type:
    | "state"
    | "transcript"
    | "token"
    | "tool_start"
    | "tool_end"
    | "confirmation_required"
    | "message"
    | "citations"
    | "audio"
    | "error"
    | "metrics";
  [key: string]: unknown;
}


/** Vues du centre de commande. */
export type ViewId =
  | "home"
  | "dashboard"
  | "conversation"
  | "calendar"
  | "email"
  | "tasks"
  | "businesses"
  | "memory"
  | "documents"
  | "integrations"
  | "settings";

/** Statut d'une source de donnees. `not_connected` n'est jamais masque. */
export type PaneStatus = "connected" | "not_connected" | "error";

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  attendees: string[];
  link: string;
}

export interface EmailHeader {
  id: string;
  thread_id: string;
  from: string;
  from_email: string;
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
}

export interface Reminder {
  id: string;
  text: string;
  due_at: string;
  due_label: string;
  status: string;
}

export interface Organization {
  id: string;
  name: string;
  kind: string;
}

export interface Pane<T> {
  status: PaneStatus;
  detail: string;
  data: T;
}

export interface Overview {
  user: string;
  clock: { iso: string; human: string; date: string; weekday: string; timezone: string };
  panes: {
    today: { status: PaneStatus; detail: string; events: CalendarEvent[] };
    email: { status: PaneStatus; detail: string; messages: EmailHeader[] };
    tasks: { status: PaneStatus; detail: string; reminders: Reminder[] };
    business: { status: PaneStatus; detail: string; organizations: Organization[] };
    memory: { status: PaneStatus; detail: string; count: number };
    documents: { status: PaneStatus; detail: string; count: number };
  };
}

/** Statut d'un indicateur business. `stale` = donnee reelle mais perimee. */
export type MetricStatus = "connected" | "not_connected" | "stale";

export interface BusinessMetric {
  metric: string;
  label: string;
  unit: string;
  value: number | null;
  /** Valeur deja mise en forme par le serveur (« 27 731,50 $ »). */
  display: string | null;
  status: MetricStatus;
  /** Vrai si la periode demandee est entierement couverte par des donnees. */
  complete: boolean;
  days_requested: number;
  days_covered: number;
  last_day: string;
  sources: string[];
  detail: string;
}

export interface BusinessOrg extends Organization {
  metrics: BusinessMetric[];
  latest_day: string;
}

export interface BusinessImport {
  id: string;
  org_id: string;
  source: string;
  source_ref: string;
  rows_ok: number;
  rows_failed: number;
  detail: string;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  org_id: string;
  kind: string;
  subject: string;
  content: string;
  source: string;
  confidence: number;
  happened_at: string | null;
  created_at: string;
}

export interface DocumentEntry {
  id: string;
  title: string;
  source: string;
  path: string;
  url: string;
  chunk_count: number;
  bytes: number;
  modified_at: string;
  indexed_at: string;
}

export interface DocumentHit {
  document_id: string;
  title: string;
  locator: string;
  text: string;
  score: number;
  matched_by: string[];
  url: string;
}
