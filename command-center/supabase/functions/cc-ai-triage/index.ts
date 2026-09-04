// =====================================================================
// cc-ai-triage — lit les courriels et documents, et agit
//
// Tourne aux 10 minutes. Pour chaque élément non encore traité :
//   1. Claude le lit avec, en contexte, l'état réel du tableau (les 67
//      tâches, qui en est responsable, ce qui est en retard).
//   2. Il en tire un classement (catégorie, urgence, résumé, prochaine
//      action) et une liste d'actions concrètes.
//   3. Chaque action passe par proposeOrApply : automatisme_policies
//      décide si elle part seule ou attend un clic.
//
// Le modèle ne décide JAMAIS de ce qui est automatisable — il propose
// des actions typées, et la table tranche. Un changement d'humeur du
// modèle ne peut donc pas transformer une proposition en courriel envoyé.
// =====================================================================

import {
  corsHeadersFor, json, assertCronSecret, db, dbWrite, askClaude, setting, truncate,
} from "../_shared/cc.ts";
import { proposeOrApply } from "../_shared/actions.ts";

const ACTION_KINDS = [
  "link_email_to_task", "link_doc_to_task", "comment_on_task", "update_task_progress",
  "create_task", "complete_task", "change_deadline", "flag_risk", "notify_member",
  "create_internal_event", "schedule_meeting", "reschedule_event",
  "draft_email_reply", "send_email",
];

// Structured outputs impose que chaque propriété soit déclarée ET
// requise. On génère donc un payload « plat » couvrant tous les types
// d'action, chaque champ étant nullable : le modèle remplit ce qui
// s'applique et met null ailleurs.
const PAYLOAD_FIELDS: Record<string, unknown> = {};
for (const f of [
  "task_code", "title", "body", "status", "priority", "workstream", "owner_name",
  "member_name", "deadline", "definition_of_done", "description", "topic", "impact",
  "mitigation", "kind", "due", "level", "link", "start", "end", "location",
  "subject", "thread_id", "event_id",
]) PAYLOAD_FIELDS[f] = { type: ["string", "null"] };
PAYLOAD_FIELDS.pct_complete = { type: ["number", "null"] };
PAYLOAD_FIELDS.cancel = { type: ["boolean", "null"] };
for (const f of ["attendees", "to", "cc"]) {
  PAYLOAD_FIELDS[f] = { type: ["array", "null"], items: { type: "string" } };
}

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ACTION_KINDS },
    title: { type: "string" },
    rationale: { type: "string" },
    confidence: { type: "number" },
    payload: { type: "object", properties: PAYLOAD_FIELDS, required: Object.keys(PAYLOAD_FIELDS), additionalProperties: false },
  },
  required: ["kind", "title", "rationale", "confidence", "payload"],
  additionalProperties: false,
};

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["proprietaire", "locataire", "fournisseur", "legal", "banque_finance",
             "marketing", "vente_prospect", "plateforme_technique", "interne",
             "administratif", "publicite_bruit", "autre"],
    },
    urgency: { type: "string", enum: ["urgent", "high", "normal", "low"] },
    summary: { type: "string" },
    next_action: { type: "string" },
    related_task_code: { type: ["string", "null"] },
    entities: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string" } },
        organizations: { type: "array", items: { type: "string" } },
        amounts: { type: "array", items: { type: "string" } },
        dates: { type: "array", items: { type: "string" } },
        addresses: { type: "array", items: { type: "string" } },
      },
      required: ["people", "organizations", "amounts", "dates", "addresses"],
      additionalProperties: false,
    },
    actions: { type: "array", items: ACTION_SCHEMA },
  },
  required: ["category", "urgency", "summary", "next_action", "related_task_code", "entities", "actions"],
  additionalProperties: false,
};

const ROLE = `Tu es le chef de cabinet de Lease Lane, une entreprise québécoise de gestion immobilière qui lance son service le 1er octobre 2026.

Ton travail : lire ce qui arrive (courriels, documents) et faire avancer le tableau de lancement. Tu écris en français québécois professionnel.

Ce qu'on attend de toi :
- Rattacher chaque élément à la tâche LL-### qu'il concerne, quand il y en a une. Ne devine pas un code : n'utilise que ceux de la liste fournie.
- Résumer en une à trois phrases ce qu'un dirigeant doit en retenir. Pas de reformulation de l'objet du courriel.
- Proposer les actions qui font réellement avancer le lancement.

Règles fermes :
- N'invente jamais un code de tâche, un nom, un montant ou une date. Si une information manque, dis-le dans le résumé plutôt que de la combler.
- L'infolettre, la publicité et les notifications automatiques n'appellent aucune action : catégorie « publicite_bruit », urgence « low », liste d'actions vide.
- « urgent » est réservé à ce qui coûte de l'argent, bloque le lancement, ou touche la sécurité d'un logement. Pas à ce qui est simplement récent.
- Un courriel qui demande une réponse mérite un brouillon (draft_email_reply), pas un envoi (send_email). Ne propose send_email que si le courriel demande une confirmation purement factuelle et sans engagement.
- Pour un rendez-vous, propose un créneau précis en tenant compte de l'agenda fourni. Ne propose jamais un créneau déjà occupé.
- Zéro action est une réponse valable et fréquente. Une action inutile coûte plus cher à l'équipe qu'aucune action.`;

// Le contexte du tableau : ce qui permet au modèle de rattacher un
// courriel à la bonne tâche plutôt que d'en inventer une.
async function boardContext(): Promise<string> {
  const [tasks, team, agenda, risks] = await Promise.all([
    db<any>("v_tasks?select=code,title,workstream,owner_name,status,priority,deadline,days_left,health"
      + "&status=neq.done&order=deadline.asc&limit=80"),
    db<any>("members?select=full_name,role_label&is_active=is.true&order=position"),
    // Lecture directe de calendar_events, pas de la vue v_agenda : celle-ci
    // est réservée au navigateur (elle exige une appartenance à l'équipe,
    // ce que le serveur n'a pas — il n'agit au nom de personne).
    db<any>(`calendar_events?select=title,starts_at,ends_at,google_accounts(members(full_name))`
      + `&status=neq.cancelled&starts_at=gte.${new Date().toISOString()}`
      + `&starts_at=lte.${new Date(Date.now() + 14 * 86400_000).toISOString()}&order=starts_at&limit=60`),
    db<any>("decisions_risks?select=kind,topic,owner_label,due,status&status=in.(open,active)&limit=20"),
  ]);

  return [
    `DATE DU JOUR : ${new Date().toISOString().slice(0, 10)}`,
    `LANCEMENT PRÉVU : 2026-10-01`,
    "",
    "ÉQUIPE :",
    ...team.map((m: any) => `- ${m.full_name} — ${m.role_label ?? ""}`),
    "",
    `TÂCHES OUVERTES (${tasks.length}) — code | titre | responsable | statut | priorité | échéance | santé :`,
    ...tasks.map((t: any) =>
      `${t.code} | ${t.title} | ${t.owner_name ?? "—"} | ${t.status} | ${t.priority} | ${t.deadline ?? "—"} | ${t.health}`),
    "",
    "DÉCISIONS ET RISQUES OUVERTS :",
    ...risks.map((r: any) => `- [${r.kind}] ${r.topic} (${r.owner_label ?? "—"}, échéance ${r.due ?? "—"})`),
    "",
    "AGENDA DES 14 PROCHAINS JOURS (créneaux déjà pris) :",
    ...agenda.map((e: any) =>
      `- ${e.google_accounts?.members?.full_name ?? "?"} : ${e.starts_at} → ${e.ends_at} — ${e.title}`),
  ].join("\n");
}

interface Triage {
  category: string; urgency: string; summary: string; next_action: string;
  related_task_code: string | null; entities: Record<string, string[]>;
  actions: { kind: string; title: string; rationale: string; confidence: number; payload: Record<string, unknown> }[];
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!assertCronSecret(req)) return json({ error: "Non autorisé." }, 401, cors);

  const batchSize = await setting<number>("triage_batch_size", 8);

  const [emails, docs] = await Promise.all([
    db<any>(`email_messages?ai_status=eq.pending&select=id,google_account_id,gmail_id,thread_id,`
      + `from_email,from_name,to_emails,subject,body_text,snippet,received_at,has_attachments`
      + `&order=received_at.desc&limit=${batchSize}`),
    db<any>(`documents?ai_status=eq.pending&select=id,name,mime_type,web_view_link,modified_at,text_excerpt`
      + `&order=modified_at.desc&limit=4`),
  ]);

  if (!emails.length && !docs.length) {
    return json({ ok: true, processed: 0, detail: "Rien de nouveau à traiter." }, 200, cors);
  }

  const context = await boardContext();
  const accountOwners = Object.fromEntries(
    (await db<any>("google_accounts?select=id,google_email,members(full_name)"))
      .map((a: any) => [a.id, { email: a.google_email, name: a.members?.full_name ?? null }]),
  );

  // Le contexte du tableau est identique pour tous les éléments de la
  // passe : marqué en cache, il n'est facturé plein tarif qu'une fois.
  const system = [
    { type: "text", text: ROLE },
    { type: "text", text: context, cache_control: { type: "ephemeral" } },
  ];

  const report = { emails: 0, documents: 0, actions_auto: 0, actions_pending: 0, errors: [] as string[] };

  for (const e of emails) {
    const owner = accountOwners[e.google_account_id];
    try {
      await dbWrite(`email_messages?id=eq.${e.id}`, "PATCH", { ai_status: "processing" }, "return=minimal");

      const result = await askClaude<Triage>({
        functionName: "cc-ai-triage/email",
        system,
        schema: TRIAGE_SCHEMA,
        maxTokens: 4000,
        content:
          `COURRIEL reçu dans la boîte de ${owner?.name ?? "?"} (${owner?.email ?? "?"})\n\n`
          + `De : ${e.from_name ?? ""} <${e.from_email ?? "?"}>\n`
          + `À : ${(e.to_emails ?? []).join(", ")}\n`
          + `Date : ${e.received_at}\n`
          + `Objet : ${e.subject ?? "(sans objet)"}\n`
          + `Pièces jointes : ${e.has_attachments ? "oui" : "non"}\n`
          + `Identifiant de fil (pour une réponse) : ${e.thread_id}\n\n`
          + `--- CORPS ---\n${truncate(e.body_text || e.snippet, 12000)}`,
      });

      const task = result.related_task_code
        ? (await db<any>(`tasks?code=eq.${encodeURIComponent(result.related_task_code)}&select=id`))[0]
        : null;

      await dbWrite(`email_messages?id=eq.${e.id}`, "PATCH", {
        ai_status: "done",
        ai_category: result.category,
        ai_urgency: result.urgency,
        ai_summary: result.summary,
        ai_action: result.next_action,
        ai_entities: result.entities,
        task_id: task?.id ?? null,
        processed_at: new Date().toISOString(),
      }, "return=minimal");

      for (const a of result.actions) {
        // Le modèle connaît le fil et l'expéditeur mieux que lui-même :
        // on complète ce qu'il aurait pu omettre plutôt que de rejeter
        // l'action.
        const payload = {
          ...a.payload,
          thread_id: a.payload.thread_id ?? e.thread_id,
          member_name: a.payload.member_name ?? owner?.name ?? null,
          to: a.payload.to ?? (a.kind.startsWith("draft_") || a.kind === "send_email" ? [e.from_email] : null),
        };
        const outcome = await proposeOrApply({
          kind: a.kind, title: a.title, rationale: a.rationale, payload,
          confidence: a.confidence, source_type: "email", source_id: e.id, task_id: task?.id ?? null,
        });
        if (outcome.status === "applied") report.actions_auto++;
        else if (outcome.status === "pending") report.actions_pending++;
      }
      report.emails++;
    } catch (err) {
      report.errors.push(`courriel ${e.id} : ${String(err).slice(0, 200)}`);
      await dbWrite(`email_messages?id=eq.${e.id}`, "PATCH",
        { ai_status: "error", ai_summary: String(err).slice(0, 400) }, "return=minimal");
    }
  }

  for (const d of docs) {
    try {
      await dbWrite(`documents?id=eq.${d.id}`, "PATCH", { ai_status: "processing" }, "return=minimal");
      // Sans texte extractible (PDF scanné, image, binaire), on garde la
      // fiche du document sans l'analyser : mieux vaut un document listé
      // qu'un résumé inventé à partir de son seul nom de fichier.
      if (!d.text_excerpt) {
        await dbWrite(`documents?id=eq.${d.id}`, "PATCH", {
          ai_status: "skipped",
          ai_summary: "Contenu non extractible automatiquement — document listé, non analysé.",
          processed_at: new Date().toISOString(),
        }, "return=minimal");
        continue;
      }

      const result = await askClaude<Triage>({
        functionName: "cc-ai-triage/document",
        system,
        schema: TRIAGE_SCHEMA,
        maxTokens: 4000,
        content: `DOCUMENT Google Drive\n\nNom : ${d.name}\nType : ${d.mime_type}\n`
          + `Modifié : ${d.modified_at}\nLien : ${d.web_view_link}\n\n`
          + `--- CONTENU ---\n${truncate(d.text_excerpt, 20000)}`,
      });

      const task = result.related_task_code
        ? (await db<any>(`tasks?code=eq.${encodeURIComponent(result.related_task_code)}&select=id`))[0]
        : null;

      await dbWrite(`documents?id=eq.${d.id}`, "PATCH", {
        ai_status: "done",
        ai_doc_type: result.category,
        ai_summary: result.summary,
        ai_extracted: result.entities,
        task_id: task?.id ?? null,
        processed_at: new Date().toISOString(),
      }, "return=minimal");

      for (const a of result.actions) {
        const outcome = await proposeOrApply({
          kind: a.kind, title: a.title, rationale: a.rationale, payload: a.payload,
          confidence: a.confidence, source_type: "document", source_id: d.id, task_id: task?.id ?? null,
        });
        if (outcome.status === "applied") report.actions_auto++;
        else if (outcome.status === "pending") report.actions_pending++;
      }
      report.documents++;
    } catch (err) {
      report.errors.push(`document ${d.id} : ${String(err).slice(0, 200)}`);
      await dbWrite(`documents?id=eq.${d.id}`, "PATCH",
        { ai_status: "error", ai_summary: String(err).slice(0, 400) }, "return=minimal");
    }
  }

  return json({ ok: true, ...report }, 200, cors);
});
