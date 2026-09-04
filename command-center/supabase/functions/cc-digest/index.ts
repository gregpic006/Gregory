// =====================================================================
// cc-digest — le point du matin et le dossier de la réunion du dimanche
//
// Deux modes :
//   • daily   — chaque matin : ce qui est en retard, ce qui arrive à
//               échéance, ce qui attend une décision. Une notification
//               ciblée par personne, pas un courriel de plus à ignorer.
//   • weekly  — le dimanche : le dossier de la réunion de 45 minutes,
//               avec 3 priorités proposées par personne, prêtes à être
//               acceptées ou corrigées en séance.
//
// La réunion du dimanche est la tâche LL-003 du tableau, et la règle
// « 3 priorités maximum par personne » vient de l'ordre du jour lui-même.
// =====================================================================

import {
  corsHeadersFor, json, assertCronSecret, db, dbWrite, askClaude, setting,
} from "../_shared/cc.ts";

const PRIORITY_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    company_state: { type: "string" },
    biggest_risk: { type: "string" },
    per_member: {
      type: "array",
      items: {
        type: "object",
        properties: {
          member_name: { type: "string" },
          priorities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task_code: { type: ["string", "null"] },
                label: { type: "string" },
                why: { type: "string" },
              },
              required: ["task_code", "label", "why"],
              additionalProperties: false,
            },
          },
          blocker: { type: ["string", "null"] },
        },
        required: ["member_name", "priorities", "blocker"],
        additionalProperties: false,
      },
    },
    decisions_needed: { type: "array", items: { type: "string" } },
  },
  required: ["headline", "company_state", "biggest_risk", "per_member", "decisions_needed"],
  additionalProperties: false,
};

async function boardSnapshot() {
  const [dash, owners, tasks, risks, suggestions] = await Promise.all([
    db<any>("v_dashboard?select=*"),
    db<any>("v_owner_summary?select=*&order=position"),
    db<any>("v_tasks?select=code,title,owner_name,status,priority,deadline,days_left,health,dependency_note"
      + "&status=neq.done&order=deadline.asc&limit=80"),
    db<any>("decisions_risks?select=kind,topic,owner_label,due,status,impact&status=in.(open,active)"),
    db<any>("ai_suggestions?status=eq.pending&select=id,kind,title,rationale,created_at&order=created_at.desc&limit=20"),
  ]);
  return { dash: dash[0] ?? {}, owners, tasks, risks, suggestions };
}

function formatSnapshot(s: Awaited<ReturnType<typeof boardSnapshot>>): string {
  return [
    `DATE : ${new Date().toISOString().slice(0, 10)}`,
    `LANCEMENT : ${s.dash.launch_date} (dans ${s.dash.days_to_launch} jours)`,
    `AVANCEMENT : ${s.dash.p0_done}/${s.dash.p0_total} tâches P0 terminées (${s.dash.p0_completion_pct} %)`,
    `EN RETARD : ${s.dash.late} · ÉCHÉANCE PROCHE : ${s.dash.due_soon} · BLOQUÉES : ${s.dash.blocked}`,
    "",
    "PAR PERSONNE (P0 ouvertes / total ouvert / en retard) :",
    ...s.owners.map((o: any) => `- ${o.full_name} (${o.role_label ?? ""}) : ${o.open_p0} / ${o.open_all} / ${o.late} en retard`),
    "",
    "TÂCHES OUVERTES — code | titre | responsable | statut | priorité | échéance | jours restants | santé | dépend de :",
    ...s.tasks.map((t: any) =>
      `${t.code} | ${t.title} | ${t.owner_name ?? "—"} | ${t.status} | ${t.priority} | ${t.deadline ?? "—"} | ${t.days_left ?? "—"} | ${t.health} | ${t.dependency_note ?? "—"}`),
    "",
    "DÉCISIONS ET RISQUES OUVERTS :",
    ...s.risks.map((r: any) => `- [${r.kind}] ${r.topic} — ${r.owner_label ?? "—"}, échéance ${r.due ?? "—"}. Impact : ${r.impact ?? "—"}`),
    "",
    `PROPOSITIONS DE L'IA EN ATTENTE D'APPROBATION (${s.suggestions.length}) :`,
    ...s.suggestions.map((x: any) => `- ${x.title} (${x.kind})`),
  ].join("\n");
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!assertCronSecret(req)) return json({ error: "Non autorisé." }, 401, cors);

  const body = await req.json().catch(() => ({}));
  const mode: string = body.mode ?? "daily";
  const snapshot = await boardSnapshot();
  const text = formatSnapshot(snapshot);

  // ---------------------------------------------------------------
  if (mode === "daily") {
    // Le point du matin est déterministe : pas d'appel au modèle. Ce
    // sont des faits (retards, échéances, approbations en attente) et
    // une requête suffit. Faire écrire ça par une IA coûterait cher pour
    // un résultat moins fiable.
    const members = await db<any>("members?select=id,full_name&is_active=is.true");
    let sent = 0;

    for (const m of members) {
      const mine = snapshot.tasks.filter((t: any) => t.owner_name === m.full_name);
      const late = mine.filter((t: any) => t.health === "late");
      const soon = mine.filter((t: any) => t.health === "due_soon");
      const blocked = mine.filter((t: any) => t.status === "blocked");
      if (!late.length && !soon.length && !blocked.length) continue;

      const parts = [
        late.length ? `${late.length} en retard : ${late.map((t: any) => t.code).join(", ")}` : null,
        soon.length ? `${soon.length} à échéance sous 3 jours : ${soon.map((t: any) => t.code).join(", ")}` : null,
        blocked.length ? `${blocked.length} bloquée(s) : ${blocked.map((t: any) => t.code).join(", ")}` : null,
      ].filter(Boolean);

      await dbWrite("notifications", "POST", {
        member_id: m.id,
        level: late.length ? "urgent" : "warning",
        title: `J-${snapshot.dash.days_to_launch} avant le lancement`,
        body: parts.join(" · "),
        link: "#board",
      }, "return=minimal");
      sent++;
    }

    if (snapshot.suggestions.length) {
      // Une ligne par personne : une notification sans destinataire ne
      // peut être marquée lue par personne (policy RLS sur member_id).
      await dbWrite("notifications", "POST", members.map((m: any) => ({
        member_id: m.id, level: "info",
        title: `${snapshot.suggestions.length} proposition(s) en attente`,
        body: "Le Command Center attend une approbation pour agir.",
        link: "#inbox",
      })), "return=minimal");
    }

    return json({ ok: true, mode, notified: sent }, 200, cors);
  }

  // ---------------------------------------------------------------
  if (mode === "weekly") {
    const result = await askClaude<{
      headline: string; company_state: string; biggest_risk: string;
      per_member: { member_name: string; priorities: { task_code: string | null; label: string; why: string }[]; blocker: string | null }[];
      decisions_needed: string[];
    }>({
      functionName: "cc-digest/weekly",
      // Le dossier de réunion est le livrable le plus stratégique du
      // système : c'est lui qui oriente la semaine des 5 personnes.
      // Il justifie un effort de raisonnement élevé, contrairement au
      // tri des courriels.
      effort: "high",
      maxTokens: 8000,
      schema: PRIORITY_SCHEMA,
      system: `Tu prépares le dossier de la réunion d'exploitation du dimanche de Lease Lane (45 minutes, 5 personnes), à quelques semaines du lancement du 1er octobre 2026.

Les règles de cette réunion, fixées par l'équipe :
- Maximum 3 priorités par personne pour les 7 prochains jours. Trois, pas cinq.
- Chaque priorité a un responsable unique et une échéance.
- Aucun blocage caché : si quelque chose coince, ça se dit.
- On priorise le chemin critique du lancement, pas ce qui est agréable à faire.

Choisis les priorités d'après les données réelles : ce qui est en retard, ce qui bloque d'autres tâches, ce qui est marqué critique. Une tâche dont dépendent plusieurs autres passe avant une tâche isolée à même échéance.

Écris en français québécois professionnel, direct, sans flatterie ni remplissage. Le « why » de chaque priorité tient en une phrase et dit la conséquence concrète de ne pas le faire cette semaine.

N'utilise que des codes de tâches présents dans les données. Si une priorité n'en a pas, mets null.`,
      content: text,
    });

    // Prochain dimanche (ou aujourd'hui si on y est déjà).
    const today = new Date();
    const daysToSunday = (7 - today.getUTCDay()) % 7;
    const meetsOn = new Date(today.getTime() + daysToSunday * 86400_000).toISOString().slice(0, 10);

    const [meeting] = await dbWrite<{ id: string }>("meetings?on_conflict=meets_on", "POST", {
      meets_on: meetsOn,
      status: "planned",
      brief: [
        `# ${result.headline}`, "",
        result.company_state, "",
        `**Risque principal :** ${result.biggest_risk}`, "",
        "## Décisions à prendre en séance",
        ...result.decisions_needed.map((d) => `- ${d}`),
      ].join("\n"),
      brief_at: new Date().toISOString(),
    }, "resolution=merge-duplicates,return=representation");

    const members = await db<any>("members?select=id,full_name&is_active=is.true");
    const byName = Object.fromEntries(members.map((m: any) => [m.full_name, m.id]));
    const taskCodes = Object.fromEntries(
      (await db<any>("tasks?select=id,code")).map((t: any) => [t.code, t.id]),
    );

    // On remplace les priorités de CETTE réunion : relancer le dossier
    // doit produire une version à jour, pas empiler des doublons.
    await dbWrite(`meeting_priorities?meeting_id=eq.${meeting.id}`, "DELETE", undefined, "return=minimal");

    const rows = result.per_member.flatMap((pm) =>
      pm.priorities.slice(0, 3).map((p, i) => ({
        meeting_id: meeting.id,
        member_id: byName[pm.member_name] ?? null,
        rank: i + 1,
        label: p.label,
        task_id: p.task_code ? taskCodes[p.task_code] ?? null : null,
        blocker: i === 0 ? pm.blocker : null,
      })),
    ).filter((r) => r.member_id);

    if (rows.length) await dbWrite("meeting_priorities", "POST", rows, "return=minimal");

    await dbWrite("notifications", "POST", members.map((m: any) => ({
      member_id: m.id, level: "info",
      title: `Dossier de la réunion du ${meetsOn} prêt`,
      body: result.headline,
      link: "#meeting",
    })), "return=minimal");

    return json({ ok: true, mode, meeting_id: meeting.id, meets_on: meetsOn, priorities: rows.length }, 200, cors);
  }

  return json({ error: `Mode inconnu : « ${mode} ».` }, 400, cors);
});
