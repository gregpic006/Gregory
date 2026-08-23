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
  features: { gmail: boolean; calendar: boolean };
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
