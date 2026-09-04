// =====================================================================
// LEASE LANE COMMAND CENTER — exécution des actions
//
// Une action proposée par l'IA suit toujours le même chemin, qu'elle
// parte en automatique ou après un clic humain : elle passe par
// applyAction(). Un seul chemin d'exécution veut dire une seule
// vérification de politique, un seul journal, un seul endroit à corriger.
//
// La règle de fond du projet (« l'IA propose, un humain ou une règle
// explicite déclenche ») est encodée dans automation_policies : c'est la
// table, pas le modèle, qui décide de ce qui part tout seul.
// =====================================================================

import { db, dbWrite, googleAccessToken, logActivity, type GoogleAccount } from "./cc.ts";
import { createEvent, patchEvent, sendGmail, createGmailDraft } from "./google.ts";

export interface ActionResult {
  ok: boolean;
  detail: string;
  data?: unknown;
}

export type PolicyMode = "auto" | "approve" | "off";

export async function policyMode(kind: string): Promise<PolicyMode | null> {
  const rows = await db<{ mode: PolicyMode }>(
    `automation_policies?kind=eq.${encodeURIComponent(kind)}&select=mode`);
  return rows.length ? rows[0].mode : null;
}

async function accountFor(memberId: string | null): Promise<GoogleAccount | null> {
  const filter = memberId ? `member_id=eq.${memberId}&` : "";
  const rows = await db<GoogleAccount>(
    `google_accounts?${filter}status=eq.active&select=id,member_id,google_email,`
    + `refresh_token_enc,access_token_enc,access_token_expires,granted_scopes,status,last_sync_at&limit=1`);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------
// L'exécuteur
//
// `payload` est produit par Claude sous un schéma imposé, donc sa forme
// est garantie — mais pas son contenu : un identifiant de tâche peut
// être inventé, une adresse peut être erronée. Chaque branche revérifie
// ce qu'elle utilise contre la base avant d'agir.
// ---------------------------------------------------------------------
export async function applyAction(
  kind: string,
  payload: Record<string, any>,
  ctx: { actorMemberId?: string | null; sourceType?: string; sourceId?: string | null; rationale?: string },
): Promise<ActionResult> {
  const actor = ctx.actorMemberId ?? null;

  const taskByCode = async (code: string | undefined) => {
    if (!code) return null;
    const rows = await db<{ id: string; code: string; title: string; status: string }>(
      `tasks?code=eq.${encodeURIComponent(code)}&select=id,code,title,status`);
    return rows[0] ?? null;
  };
  const memberByName = async (name: string | undefined) => {
    if (!name) return null;
    const rows = await db<{ id: string; full_name: string }>(
      `members?full_name=eq.${encodeURIComponent(name)}&select=id,full_name`);
    return rows[0] ?? null;
  };

  switch (kind) {
    // -----------------------------------------------------------------
    case "link_email_to_task":
    case "link_doc_to_task": {
      const task = await taskByCode(payload.task_code);
      if (!task) return { ok: false, detail: `Tâche ${payload.task_code} introuvable.` };
      const table = kind === "link_email_to_task" ? "email_messages" : "documents";
      if (!ctx.sourceId) return { ok: false, detail: "Source manquante." };
      await dbWrite(`${table}?id=eq.${ctx.sourceId}`, "PATCH", { task_id: task.id }, "return=minimal");
      return { ok: true, detail: `Rattaché à ${task.code}.`, data: { task_id: task.id } };
    }

    case "comment_on_task": {
      const task = await taskByCode(payload.task_code);
      if (!task) return { ok: false, detail: `Tâche ${payload.task_code} introuvable.` };
      await dbWrite("task_comments", "POST", {
        task_id: task.id, author_kind: "ai", body: payload.body,
      }, "return=minimal");
      return { ok: true, detail: `Note ajoutée sur ${task.code}.` };
    }

    case "update_task_progress": {
      const task = await taskByCode(payload.task_code);
      if (!task) return { ok: false, detail: `Tâche ${payload.task_code} introuvable.` };

      // Garde-fou : clore une tâche est une décision humaine, quelle que
      // soit la politique. Si le modèle propose « done » ici plutôt que
      // via complete_task, on plafonne à « en cours ».
      const status = payload.status === "done" ? "in_progress" : payload.status;
      const patch: Record<string, unknown> = {};
      if (status && ["not_started", "in_progress", "waiting", "blocked", "at_risk"].includes(status)) {
        patch.status = status;
      }
      if (typeof payload.pct_complete === "number") {
        patch.pct_complete = Math.max(0, Math.min(0.95, payload.pct_complete));
      }
      if (!Object.keys(patch).length) return { ok: false, detail: "Rien à mettre à jour." };

      await dbWrite(`tasks?id=eq.${task.id}`, "PATCH", patch, "return=minimal");
      await logActivity({
        entity_type: "task", entity_id: task.id, actor_kind: "ai", action: "ai_updated_progress",
        summary: `${task.code} mis à jour par l'IA : ${JSON.stringify(patch)}`,
        details: { rationale: ctx.rationale, source: ctx.sourceType },
      });
      return { ok: true, detail: `${task.code} mis à jour.` };
    }

    case "create_task": {
      const owner = await memberByName(payload.owner_name);
      // Les codes LL-### sont la langue commune de l'équipe : une tâche
      // née d'un courriel doit en avoir un, à la suite des existantes.
      const last = await db<{ code: string }>("tasks?code=like.LL-*&select=code&order=code.desc&limit=1");
      const next = last.length ? Number(last[0].code.slice(3)) + 1 : 68;
      const code = `LL-${String(next).padStart(3, "0")}`;

      const [row] = await dbWrite<{ id: string }>("tasks", "POST", {
        code,
        workstream: payload.workstream ?? "Operations",
        title: payload.title,
        description: payload.description ?? null,
        owner_member_id: owner?.id ?? null,
        priority: ["p0", "p1", "p2"].includes(payload.priority) ? payload.priority : "p1",
        deadline: payload.deadline ?? null,
        definition_of_done: payload.definition_of_done ?? null,
        notes: ctx.rationale ? `Créée automatiquement : ${ctx.rationale}` : null,
        source: "ai",
      });
      await logActivity({
        entity_type: "task", entity_id: row.id, actor_kind: "ai", action: "ai_created_task",
        summary: `${code} — ${payload.title}`, details: { source: ctx.sourceType, source_id: ctx.sourceId },
      });
      return { ok: true, detail: `Tâche ${code} créée.`, data: { task_id: row.id, code } };
    }

    case "complete_task": {
      const task = await taskByCode(payload.task_code);
      if (!task) return { ok: false, detail: `Tâche ${payload.task_code} introuvable.` };
      await dbWrite(`tasks?id=eq.${task.id}`, "PATCH",
        { status: "done", pct_complete: 1, updated_by: actor }, "return=minimal");
      return { ok: true, detail: `${task.code} marquée terminée.` };
    }

    case "change_deadline": {
      const task = await taskByCode(payload.task_code);
      if (!task) return { ok: false, detail: `Tâche ${payload.task_code} introuvable.` };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.deadline ?? "")) {
        return { ok: false, detail: "Date invalide (attendu AAAA-MM-JJ)." };
      }
      await dbWrite(`tasks?id=eq.${task.id}`, "PATCH",
        { deadline: payload.deadline, updated_by: actor }, "return=minimal");
      return { ok: true, detail: `Échéance de ${task.code} déplacée au ${payload.deadline}.` };
    }

    case "flag_risk": {
      const task = await taskByCode(payload.task_code);
      await dbWrite("decisions_risks", "POST", {
        kind: payload.kind === "decision" ? "decision" : "risk",
        topic: payload.topic,
        owner_label: payload.owner_name ?? null,
        owner_member_id: (await memberByName(payload.owner_name))?.id ?? null,
        due: payload.due ?? null,
        status: "active",
        resolution: payload.mitigation ?? null,
        impact: payload.impact ?? null,
        related_task_id: task?.id ?? null,
      }, "resolution=ignore-duplicates,return=minimal");
      return { ok: true, detail: `Risque consigné : ${payload.topic}` };
    }

    case "notify_member": {
      const target = await memberByName(payload.member_name);
      const level = ["info", "warning", "urgent"].includes(payload.level) ? payload.level : "info";
      const base = { level, title: payload.title, body: payload.body ?? null, link: payload.link ?? null };

      // Une notification « pour tout le monde » est distribuée en une
      // ligne par personne, pas laissée avec member_id null : chacun doit
      // pouvoir la marquer comme lue chez lui, ce que le RLS
      // (member_id = cc_member_id()) ne permet pas sur une ligne orpheline.
      const targets = target
        ? [target.id]
        : (await db<{ id: string }>("members?is_active=is.true&select=id")).map((m) => m.id);

      await dbWrite("notifications", "POST",
        targets.map((id) => ({ member_id: id, ...base })), "return=minimal");
      return { ok: true, detail: `Notification envoyée à ${payload.member_name ?? "toute l'équipe"}.` };
    }

    // -----------------------------------------------------------------
    // Agenda — passe par le compte Google de la personne concernée, pour
    // que l'événement apparaisse bien dans SON agenda, avec son identité
    // comme organisateur.
    case "create_internal_event":
    case "schedule_meeting": {
      const owner = await memberByName(payload.member_name);
      const account = await accountFor(owner?.id ?? null);
      if (!account) return { ok: false, detail: "Aucun compte Google actif pour créer l'événement." };
      if (!account.granted_scopes?.includes("https://www.googleapis.com/auth/calendar")) {
        return { ok: false, detail: `Le compte ${account.google_email} n'a pas l'autorisation Agenda.` };
      }
      if (!payload.start || !payload.end) return { ok: false, detail: "Début et fin requis." };

      const token = await googleAccessToken(account);
      const event = await createEvent(token, "primary", {
        summary: payload.title,
        description: [payload.description, ctx.rationale ? `\n— Proposé par le Command Center : ${ctx.rationale}` : ""]
          .filter(Boolean).join("\n"),
        location: payload.location,
        start: payload.start,
        end: payload.end,
        attendees: payload.attendees ?? [],
        // Un événement interne ne doit pas déclencher une vague de
        // courriels d'invitation à toute l'équipe.
        sendUpdates: kind === "schedule_meeting" ? "all" : "none",
      });

      const task = await taskByCode(payload.task_code);
      await dbWrite("calendar_events?on_conflict=google_account_id,calendar_id,google_event_id", "POST", {
        google_account_id: account.id,
        google_event_id: event.id,
        calendar_id: "primary",
        title: payload.title,
        description: payload.description ?? null,
        location: payload.location ?? null,
        starts_at: payload.start,
        ends_at: payload.end,
        attendees: (payload.attendees ?? []).map((e: string) => ({ email: e })),
        organizer_email: account.google_email,
        html_link: event.htmlLink ?? null,
        origin: "command_center",
        task_id: task?.id ?? null,
      }, "resolution=merge-duplicates,return=minimal");

      return { ok: true, detail: `Événement créé le ${payload.start}.`, data: { event_id: event.id } };
    }

    case "reschedule_event": {
      const rows = await db<{ id: string; google_account_id: string; google_event_id: string; calendar_id: string; title: string }>(
        `calendar_events?id=eq.${payload.event_id}&select=id,google_account_id,google_event_id,calendar_id,title`);
      if (!rows.length) return { ok: false, detail: "Événement introuvable." };
      const ev = rows[0];
      const [account] = await db<GoogleAccount>(
        `google_accounts?id=eq.${ev.google_account_id}&select=id,member_id,google_email,refresh_token_enc,`
        + `access_token_enc,access_token_expires,granted_scopes,status,last_sync_at`);
      if (!account) return { ok: false, detail: "Compte Google introuvable." };

      const token = await googleAccessToken(account);
      if (payload.cancel === true) {
        await patchEvent(token, ev.calendar_id, ev.google_event_id, { status: "cancelled" });
        await dbWrite(`calendar_events?id=eq.${ev.id}`, "PATCH", { status: "cancelled" }, "return=minimal");
        return { ok: true, detail: `« ${ev.title} » annulé.` };
      }
      if (!payload.start || !payload.end) return { ok: false, detail: "Nouveau créneau requis." };
      await patchEvent(token, ev.calendar_id, ev.google_event_id, {
        start: { dateTime: payload.start }, end: { dateTime: payload.end },
      });
      await dbWrite(`calendar_events?id=eq.${ev.id}`, "PATCH",
        { starts_at: payload.start, ends_at: payload.end }, "return=minimal");
      return { ok: true, detail: `« ${ev.title} » déplacé au ${payload.start}.` };
    }

    // -----------------------------------------------------------------
    // Courriel sortant — toujours envoyé depuis le compte de la personne
    // concernée, jamais depuis une adresse générique.
    case "draft_email_reply":
    case "send_email": {
      const owner = await memberByName(payload.member_name);
      const account = await accountFor(owner?.id ?? null);
      if (!account) return { ok: false, detail: "Aucun compte Google actif pour écrire." };

      const to: string[] = Array.isArray(payload.to) ? payload.to : [payload.to].filter(Boolean);
      if (!to.length) return { ok: false, detail: "Destinataire manquant." };
      const token = await googleAccessToken(account);

      if (kind === "draft_email_reply") {
        const draft = await createGmailDraft(token, {
          to, subject: payload.subject ?? "(sans objet)", body: payload.body ?? "",
          threadId: payload.thread_id,
        });
        return {
          ok: true,
          detail: `Brouillon prêt dans Gmail (${account.google_email}) — rien n'est parti.`,
          data: { draft_id: draft.id },
        };
      }

      if (!account.granted_scopes?.includes("https://www.googleapis.com/auth/gmail.send")) {
        return { ok: false, detail: `Le compte ${account.google_email} n'a pas l'autorisation d'envoi.` };
      }
      const sent = await sendGmail(token, {
        to, cc: payload.cc, subject: payload.subject ?? "(sans objet)",
        body: payload.body ?? "", threadId: payload.thread_id,
      });
      await logActivity({
        entity_type: "email", actor_kind: "ai", member_id: actor, action: "email_sent",
        summary: `Courriel envoyé à ${to.join(", ")} depuis ${account.google_email}.`,
        details: { subject: payload.subject },
      });
      return { ok: true, detail: `Envoyé à ${to.join(", ")}.`, data: { message_id: sent.id } };
    }

    default:
      return { ok: false, detail: `Type d'action inconnu : ${kind}.` };
  }
}

// Enregistre une proposition, et l'exécute tout de suite si la politique
// le permet. C'est le seul point d'entrée utilisé par cc-ai-triage.
export async function proposeOrApply(suggestion: {
  kind: string;
  title: string;
  rationale?: string;
  payload: Record<string, unknown>;
  confidence?: number;
  source_type?: string;
  source_id?: string | null;
  task_id?: string | null;
}): Promise<{ status: string; detail: string }> {
  const mode = await policyMode(suggestion.kind);
  if (mode === null) return { status: "skipped", detail: `Type inconnu : ${suggestion.kind}` };
  if (mode === "off") return { status: "skipped", detail: "Automatisation désactivée." };

  const [row] = await dbWrite<{ id: string }>("ai_suggestions", "POST", {
    kind: suggestion.kind,
    title: suggestion.title,
    rationale: suggestion.rationale ?? null,
    payload: suggestion.payload,
    confidence: suggestion.confidence ?? null,
    source_type: suggestion.source_type ?? null,
    source_id: suggestion.source_id ?? null,
    task_id: suggestion.task_id ?? null,
    status: "pending",
  });

  if (mode === "approve") {
    return { status: "pending", detail: "En attente d'approbation." };
  }

  const result = await applyAction(suggestion.kind, suggestion.payload as Record<string, any>, {
    sourceType: suggestion.source_type,
    sourceId: suggestion.source_id,
    rationale: suggestion.rationale,
  });
  await dbWrite(`ai_suggestions?id=eq.${row.id}`, "PATCH", {
    status: result.ok ? "applied" : "failed",
    applied_at: new Date().toISOString(),
    result: { detail: result.detail, data: result.data ?? null },
    error: result.ok ? null : result.detail,
  }, "return=minimal");

  return { status: result.ok ? "applied" : "failed", detail: result.detail };
}
