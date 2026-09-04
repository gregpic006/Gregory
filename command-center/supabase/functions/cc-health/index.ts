// =====================================================================
// cc-health — état du Command Center, en lecture seule et sans secret
//
// Pensée pour un moniteur externe gratuit (UptimeRobot) : répond 200 si
// tout tourne, 503 sinon. Ne renvoie aucune donnée d'affaires — juste
// des compteurs et des drapeaux.
// =====================================================================

import { corsHeadersFor, json, db } from "../_shared/cc.ts";

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    const accounts = await db<{ id: string; status: string; last_sync_at: string | null }>(
      "google_accounts?select=id,status,last_sync_at",
    );

    checks.database = { ok: true };

    const broken = accounts.filter((a) => a.status === "needs_reauth");
    checks.google_accounts = {
      ok: broken.length === 0,
      detail: `${accounts.length} connecté(s), ${broken.length} à reconnecter`,
    };

    // Une synchro muette depuis 2 h veut dire que le cron ne tourne plus
    // (ou que Google refuse) — c'est le symptôme qui compte, pas la cause.
    const stale = accounts.filter((a) =>
      a.status === "active" &&
      (!a.last_sync_at || Date.now() - new Date(a.last_sync_at).getTime() > 2 * 3600_000)
    );
    checks.sync_freshness = {
      ok: accounts.length === 0 || stale.length === 0,
      detail: stale.length ? `${stale.length} compte(s) sans synchro depuis plus de 2 h` : "à jour",
    };

    const failures = await db<{ id: string }>(
      `ai_run_log?ok=is.false&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}&select=id`,
    );
    checks.ai = { ok: failures.length <= 10, detail: `${failures.length} échec(s) IA sur 24 h` };

    const allOk = Object.values(checks).every((c) => c.ok);
    return json({ status: allOk ? "ok" : "degraded", checks, at: new Date().toISOString() },
      allOk ? 200 : 503, cors);
  } catch (err) {
    return json({ status: "down", error: String(err), checks }, 503, cors);
  }
});
