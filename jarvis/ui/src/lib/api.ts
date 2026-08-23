/** Client REST minimal de l'API JARVIS. */

import type { SystemInfo } from "./types";

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
