// =====================================================================
// cc-google-sync — rapatrie courriels, agenda et documents des 4 comptes
//
// Tourne aux 5 minutes (pg_cron). Ne raisonne sur rien : elle copie, et
// laisse cc-ai-triage interpréter. Cette séparation compte — une panne
// de l'API Anthropic ne doit pas faire perdre des courriels, et un
// changement de logique de tri ne doit pas obliger à retélécharger la
// boîte.
//
// Chaque compte est traité indépendamment : si le jeton de l'un est
// révoqué, les trois autres se synchronisent quand même.
// =====================================================================

import {
  corsHeadersFor, json, assertCronSecret, db, dbWrite,
  googleAccessToken, logActivity, setting, type GoogleAccount,
} from "../_shared/cc.ts";
import {
  listNewGmailIds, fetchGmailMessage, listEvents, listDriveFiles,
} from "../_shared/google.ts";

interface SyncState {
  id: string;
  google_account_id: string;
  source: string;
  cursor: string | null;
  last_ok_at: string | null;
}

async function stateFor(accountId: string, source: string): Promise<SyncState> {
  const rows = await db<SyncState>(
    `sync_state?google_account_id=eq.${accountId}&source=eq.${source}&select=*`);
  if (rows.length) return rows[0];
  const [created] = await dbWrite<SyncState>("sync_state", "POST", {
    google_account_id: accountId, source,
  });
  return created;
}

async function markState(id: string, patch: Record<string, unknown>) {
  await dbWrite(`sync_state?id=eq.${id}`, "PATCH",
    { last_run_at: new Date().toISOString(), ...patch }, "return=minimal");
}

// --- Gmail -----------------------------------------------------------
async function syncGmail(account: GoogleAccount, token: string): Promise<number> {
  const state = await stateFor(account.id, "gmail");
  const since = state.cursor ? Number(state.cursor) : null;

  const ids = await listNewGmailIds(token, since);
  if (!ids.length) {
    await markState(state.id, { last_ok_at: new Date().toISOString(), last_error: null });
    return 0;
  }

  // On ne redemande à Gmail que ce qu'on n'a pas déjà : sur une passe
  // normale la fenêtre `after:` renvoie souvent les mêmes identifiants
  // que la fois précédente (précision à la seconde).
  const known = await db<{ gmail_id: string }>(
    `email_messages?google_account_id=eq.${account.id}`
    + `&gmail_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=gmail_id`);
  const knownSet = new Set(known.map((k) => k.gmail_id));
  const fresh = ids.filter((id) => !knownSet.has(id));

  let latest = since ?? 0;
  const rows = [];
  for (const id of fresh) {
    try {
      const parsed = await fetchGmailMessage(token, id);
      rows.push({ google_account_id: account.id, ...parsed });
      if (parsed.received_at) {
        latest = Math.max(latest, Math.floor(new Date(parsed.received_at).getTime() / 1000));
      }
    } catch (err) {
      // Un message illisible (supprimé entre-temps, format exotique) ne
      // doit pas interrompre les autres.
      await logActivity({
        entity_type: "sync", actor_kind: "system", action: "gmail_message_failed",
        summary: `Courriel ${id} illisible.`, details: { error: String(err) },
      });
    }
  }

  if (rows.length) {
    await dbWrite("email_messages?on_conflict=google_account_id,gmail_id", "POST", rows,
      "resolution=ignore-duplicates,return=minimal");
  }

  await markState(state.id, {
    // Reculer d'une seconde évite de rater un courriel arrivé dans la
    // même seconde que le dernier traité.
    cursor: latest ? String(latest - 1) : state.cursor,
    last_ok_at: new Date().toISOString(),
    last_error: null,
  });
  return rows.length;
}

// --- Agenda ----------------------------------------------------------
async function syncCalendar(account: GoogleAccount, token: string): Promise<number> {
  const state = await stateFor(account.id, "calendar");
  const events = await listEvents(token, "primary");

  if (events.length) {
    await dbWrite("calendar_events?on_conflict=google_account_id,calendar_id,google_event_id", "POST",
      events.map((e) => ({
        google_account_id: account.id, ...e, updated_at: new Date().toISOString(),
      })),
      "resolution=merge-duplicates,return=minimal");
  }

  // Un événement supprimé dans Google reste dans notre base tant qu'on
  // ne le marque pas : sans ça l'agenda du Command Center afficherait
  // des rendez-vous annulés.
  const seen = new Set(events.map((e) => e.google_event_id));
  const stored = await db<{ id: string; google_event_id: string; starts_at: string }>(
    `calendar_events?google_account_id=eq.${account.id}&calendar_id=eq.primary`
    + `&status=neq.cancelled&starts_at=gte.${new Date(Date.now() - 14 * 86400_000).toISOString()}`
    + `&select=id,google_event_id,starts_at`);
  const vanished = stored.filter((s) => !seen.has(s.google_event_id));
  for (const v of vanished) {
    await dbWrite(`calendar_events?id=eq.${v.id}`, "PATCH", { status: "cancelled" }, "return=minimal");
  }

  await markState(state.id, { last_ok_at: new Date().toISOString(), last_error: null });
  return events.length;
}

// --- Drive -----------------------------------------------------------
async function syncDrive(account: GoogleAccount, token: string): Promise<number> {
  const state = await stateFor(account.id, "drive");
  const files = await listDriveFiles(token, state.cursor);
  if (files.length) {
    await dbWrite("documents?on_conflict=google_account_id,origin,source_ref", "POST",
      files.map((f) => ({ google_account_id: account.id, origin: "drive", ...f })),
      "resolution=ignore-duplicates,return=minimal");
  }
  const newest = files.map((f) => f.modified_at).filter(Boolean).sort().pop();
  await markState(state.id, {
    cursor: newest ?? state.cursor,
    last_ok_at: new Date().toISOString(),
    last_error: null,
  });
  return files.length;
}

// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // Cette fonction lit toutes les boîtes courriel de l'entreprise. Elle
  // n'est appelable qu'avec le secret partagé, jamais depuis un
  // navigateur.
  if (!assertCronSecret(req)) return json({ error: "Non autorisé." }, 401, cors);

  if (!(await setting<boolean>("sync_enabled", true))) {
    return json({ skipped: "Synchronisation désactivée dans les réglages." }, 200, cors);
  }

  const accounts = await db<GoogleAccount>(
    "google_accounts?status=eq.active&select=id,member_id,google_email,refresh_token_enc,"
    + "access_token_enc,access_token_expires,granted_scopes,status,last_sync_at");

  const report: Record<string, unknown>[] = [];

  for (const account of accounts) {
    const scopes = account.granted_scopes ?? [];
    const entry: Record<string, unknown> = { account: account.google_email };
    try {
      const token = await googleAccessToken(account);

      // Chaque source est tentée séparément : une autorisation Drive
      // refusée ne doit pas empêcher la lecture des courriels.
      for (
        const [name, fn, scope] of [
          ["emails", syncGmail, "https://www.googleapis.com/auth/gmail.readonly"],
          ["events", syncCalendar, "https://www.googleapis.com/auth/calendar"],
          ["documents", syncDrive, "https://www.googleapis.com/auth/drive.readonly"],
        ] as const
      ) {
        if (!scopes.includes(scope)) { entry[name] = "autorisation absente"; continue; }
        try {
          entry[name] = await fn(account, token);
        } catch (err) {
          entry[name] = `erreur : ${String(err).slice(0, 200)}`;
          await markState((await stateFor(account.id, name === "emails" ? "gmail" : name === "events" ? "calendar" : "drive")).id,
            { last_error: String(err).slice(0, 500) });
        }
      }

      await dbWrite(`google_accounts?id=eq.${account.id}`, "PATCH", {
        last_sync_at: new Date().toISOString(), last_error: null,
      }, "return=minimal");
    } catch (err) {
      entry.error = String(err).slice(0, 300);
      await dbWrite(`google_accounts?id=eq.${account.id}`, "PATCH", {
        last_error: String(err).slice(0, 500),
      }, "return=minimal");
    }
    report.push(entry);
  }

  return json({ ok: true, accounts: report, at: new Date().toISOString() }, 200, cors);
});
