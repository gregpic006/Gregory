// =====================================================================
// cc-board-api — tout ce que le navigateur ne peut pas faire lui-même
//
// Le tableau (tâches, portes, décisions, KPI) est lu et écrit en direct
// par le navigateur via PostgREST + RLS : c'est ce qui rend le temps réel
// possible sans passer par une API. Cette fonction ne sert donc qu'aux
// actions qui exigent le service_role ou une règle métier :
//
//   • ouvrir la session (qui suis-je, quels réglages, quelles connexions)
//   • gérer l'équipe (déclarer les adresses des 4 autres)
//   • régler les automatisations et les réglages généraux
//   • déclencher une synchronisation à la demande
//
// Les jetons Google ne sortent JAMAIS d'ici — seulement leur état.
// =====================================================================

import {
  corsHeadersFor, json, requireMember, db, dbWrite, logActivity, SUPABASE_URL, SERVICE_KEY,
} from "../_shared/cc.ts";

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const auth = await requireMember(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
    const { member } = auth;

    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? "";

    // Toute action de configuration est réservée aux admins. Le tableau
    // lui-même reste ouvert à toute l'équipe (voir le RLS) — c'est la
    // configuration qui est protégée, pas le travail quotidien.
    const adminOnly = [
      "team_add_email", "team_remove_email", "team_set_admin", "team_add_member",
      "settings_set", "policy_set", "disconnect_account",
    ];
    if (adminOnly.includes(action) && !member.is_admin) {
      return json({ error: "Réservé aux administrateurs du Command Center." }, 403, cors);
    }

    switch (action) {
      // -------------------------------------------------------------
      case "session": {
        const [team, settings, policies, accounts] = await Promise.all([
          db(`members?select=id,full_name,role_label,is_admin,is_active,avatar_url,position,`
            + `member_emails(email,is_primary)&order=position`),
          db<{ key: string; value: unknown }>("app_settings?select=key,value"),
          db("automation_policies?select=kind,label,description,mode,is_outbound&order=kind"),
          db<{ id: string; member_id: string; google_email: string; status: string; last_sync_at: string; last_error: string; granted_scopes: string[] }>(
            "google_accounts?select=id,member_id,google_email,status,last_sync_at,last_error,granted_scopes",
          ),
        ]);

        return json({
          me: member,
          team,
          settings: Object.fromEntries((settings as { key: string; value: unknown }[]).map((s) => [s.key, s.value])),
          policies,
          // On expose l'état des connexions, jamais les jetons : ni
          // refresh_token_enc ni access_token_enc ne figurent dans le
          // select ci-dessus.
          connections: accounts.map((a) => ({
            id: a.id, member_id: a.member_id, google_email: a.google_email,
            status: a.status, last_sync_at: a.last_sync_at, last_error: a.last_error,
            scope_count: (a.granted_scopes ?? []).length,
          })),
          my_connection: accounts.find((a) => a.member_id === member.id) ?? null,
        }, 200, cors);
      }

      // -------------------------------------------------------------
      // Déclarer l'adresse de quelqu'un, c'est lui ouvrir la porte : dès
      // qu'elle est enregistrée, la personne se connecte avec Google et
      // son compte se rattache tout seul (trigger cc_link_auth_user).
      case "team_add_email": {
        const email = String(body.email ?? "").toLowerCase().trim();
        const memberId = String(body.member_id ?? "");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: "Adresse courriel invalide." }, 400, cors);
        }
        const target = await db<{ id: string; full_name: string }>(
          `members?id=eq.${memberId}&select=id,full_name`);
        if (!target.length) return json({ error: "Membre introuvable." }, 404, cors);

        const existing = await db<{ member_id: string }>(
          `member_emails?email=eq.${encodeURIComponent(email)}&select=member_id`);
        if (existing.length) {
          return json({ error: "Cette adresse est déjà déclarée pour quelqu'un." }, 409, cors);
        }

        await dbWrite("member_emails", "POST", { member_id: memberId, email }, "return=minimal");
        await logActivity({
          entity_type: "member", entity_id: memberId, actor_kind: "human", member_id: member.id,
          action: "email_added",
          summary: `${member.full_name} a déclaré ${email} pour ${target[0].full_name}.`,
        });
        return json({ ok: true }, 200, cors);
      }

      case "team_remove_email": {
        const email = String(body.email ?? "").toLowerCase().trim();
        await dbWrite(`member_emails?email=eq.${encodeURIComponent(email)}`, "DELETE", undefined, "return=minimal");
        await logActivity({
          entity_type: "member", actor_kind: "human", member_id: member.id,
          action: "email_removed", summary: `${member.full_name} a retiré ${email}.`,
        });
        return json({ ok: true }, 200, cors);
      }

      case "team_add_member": {
        const name = String(body.full_name ?? "").trim();
        if (!name) return json({ error: "Nom requis." }, 400, cors);
        const [row] = await dbWrite<{ id: string }>("members", "POST", {
          full_name: name,
          role_label: body.role_label ?? null,
          position: body.position ?? 100,
        });
        return json({ ok: true, member_id: row.id }, 200, cors);
      }

      case "team_set_admin": {
        const memberId = String(body.member_id ?? "");
        const makeAdmin = body.is_admin === true;

        // Retirer le dernier admin rendrait la configuration
        // définitivement inaccessible — il n'y a pas d'écran de secours.
        if (!makeAdmin) {
          const admins = await db<{ id: string }>("members?is_admin=is.true&is_active=is.true&select=id");
          if (admins.length <= 1 && admins.some((a) => a.id === memberId)) {
            return json({ error: "Impossible de retirer le dernier administrateur." }, 409, cors);
          }
        }
        await dbWrite(`members?id=eq.${memberId}`, "PATCH", { is_admin: makeAdmin }, "return=minimal");
        return json({ ok: true }, 200, cors);
      }

      // -------------------------------------------------------------
      case "settings_set": {
        const key = String(body.key ?? "");
        if (!key) return json({ error: "Clé requise." }, 400, cors);
        await dbWrite("app_settings", "POST",
          { key, value: body.value, updated_by: member.id, updated_at: new Date().toISOString() },
          "resolution=merge-duplicates,return=minimal");
        await logActivity({
          entity_type: "settings", actor_kind: "human", member_id: member.id, action: "setting_changed",
          summary: `${member.full_name} a changé « ${key} ».`, details: { key, value: body.value },
        });
        return json({ ok: true }, 200, cors);
      }

      case "policy_set": {
        const kind = String(body.kind ?? "");
        const mode = String(body.mode ?? "");
        if (!["auto", "approve", "off"].includes(mode)) {
          return json({ error: "Mode invalide (auto, approve ou off)." }, 400, cors);
        }
        const [updated] = await dbWrite<{ kind: string; label: string; is_outbound: boolean }>(
          `automation_policies?kind=eq.${encodeURIComponent(kind)}`, "PATCH",
          { mode, updated_by: member.id, updated_at: new Date().toISOString() });
        if (!updated) return json({ error: "Automatisation inconnue." }, 404, cors);

        await logActivity({
          entity_type: "automation", actor_kind: "human", member_id: member.id, action: "policy_changed",
          summary: `${member.full_name} a réglé « ${updated.label} » sur ${mode}.`,
          details: { kind, mode, is_outbound: updated.is_outbound },
        });
        return json({ ok: true }, 200, cors);
      }

      // -------------------------------------------------------------
      case "disconnect_account": {
        const accountId = String(body.account_id ?? "");
        const [acct] = await db<{ google_email: string }>(
          `google_accounts?id=eq.${accountId}&select=google_email`);
        if (!acct) return json({ error: "Compte introuvable." }, 404, cors);

        // On supprime la ligne : les jetons partent avec, et les
        // courriels/événements déjà synchronisés aussi (cascade). C'est
        // volontaire — déconnecter doit vraiment tout retirer.
        await dbWrite(`google_accounts?id=eq.${accountId}`, "DELETE", undefined, "return=minimal");
        await logActivity({
          entity_type: "google_account", actor_kind: "human", member_id: member.id,
          action: "google_disconnected",
          summary: `${member.full_name} a déconnecté ${acct.google_email}.`,
        });
        return json({ ok: true }, 200, cors);
      }

      // -------------------------------------------------------------
      // « Synchroniser maintenant » : réveille le cron sans attendre les
      // 5 minutes. On relaie le secret côté serveur — il ne transite
      // jamais par le navigateur.
      // Même principe que sync_now : le dossier de réunion se prépare
      // normalement le dimanche matin, mais on doit pouvoir le relancer
      // depuis l'interface — sinon le bouton ne sert à rien.
      case "digest_now": {
        const secret = Deno.env.get("CC_CRON_SECRET") ?? "";
        const res = await fetch(`${SUPABASE_URL}/functions/v1/cc-digest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "x-cc-cron-secret": secret,
          },
          body: JSON.stringify({ mode: body.mode === "daily" ? "daily" : "weekly" }),
        });
        const result = await res.json().catch(() => ({}));
        return json({ ok: res.ok, result }, res.ok ? 200 : 502, cors);
      }

      case "sync_now": {
        const secret = Deno.env.get("CC_CRON_SECRET") ?? "";
        const res = await fetch(`${SUPABASE_URL}/functions/v1/cc-google-sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "x-cc-cron-secret": secret,
          },
          body: JSON.stringify({ triggered_by: member.id }),
        });
        const result = await res.json().catch(() => ({}));
        return json({ ok: res.ok, result }, res.ok ? 200 : 502, cors);
      }

      default:
        return json({ error: `Action inconnue : « ${action} ».` }, 400, cors);
    }
  } catch (err) {
    return json({ error: String(err) }, 500, cors);
  }
});
