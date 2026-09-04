// =====================================================================
// cc-apply-suggestion — le clic humain sur une proposition de l'IA
//
// Décider et exécuter se font dans le MÊME appel. C'est délibéré : si le
// navigateur pouvait marquer une suggestion « approuvée » sans
// l'exécuter, l'équipe verrait des actions approuvées qui ne se sont
// jamais produites. D'où l'absence de policy d'écriture sur
// ai_suggestions (voir la migration RLS).
// =====================================================================

import { corsHeadersFor, json, requireMember, db, dbWrite, logActivity } from "../_shared/cc.ts";
import { applyAction } from "../_shared/actions.ts";

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const auth = await requireMember(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
    const { member } = auth;

    const body = await req.json().catch(() => ({}));
    const decision: string = body.decision ?? "";
    const ids: string[] = Array.isArray(body.suggestion_ids)
      ? body.suggestion_ids
      : [body.suggestion_id].filter(Boolean);

    if (!ids.length) return json({ error: "Aucune suggestion visée." }, 400, cors);
    if (!["approve", "reject"].includes(decision)) {
      return json({ error: "Décision attendue : approve ou reject." }, 400, cors);
    }

    const suggestions = await db<{
      id: string; kind: string; title: string; rationale: string;
      payload: Record<string, any>; status: string; source_type: string; source_id: string;
    }>(`ai_suggestions?id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=*`);

    const results: Record<string, unknown>[] = [];

    for (const s of suggestions) {
      // Une suggestion déjà tranchée ne se rejoue pas : sans ce garde-fou,
      // un double-clic enverrait deux fois le même courriel.
      if (s.status !== "pending") {
        results.push({ id: s.id, skipped: `déjà « ${s.status} »` });
        continue;
      }

      if (decision === "reject") {
        await dbWrite(`ai_suggestions?id=eq.${s.id}`, "PATCH", {
          status: "rejected", decided_by: member.id, decided_at: new Date().toISOString(),
        }, "return=minimal");
        await logActivity({
          entity_type: "suggestion", entity_id: s.id, actor_kind: "human", member_id: member.id,
          action: "suggestion_rejected", summary: `${member.full_name} a refusé : ${s.title}`,
        });
        results.push({ id: s.id, status: "rejected" });
        continue;
      }

      // Le payload proposé peut être ajusté avant approbation (corriger
      // une heure, réécrire un courriel) : c'est cette version-là qui
      // s'exécute et qui est conservée.
      const payload = body.payload_override && ids.length === 1
        ? { ...s.payload, ...body.payload_override }
        : s.payload;

      // On marque « approuvée » AVANT d'exécuter : si l'exécution plante
      // ou expire, la trace montre une tentative, pas une suggestion
      // restée en attente sur laquelle quelqu'un recliquera.
      await dbWrite(`ai_suggestions?id=eq.${s.id}`, "PATCH", {
        status: "approved", payload, decided_by: member.id, decided_at: new Date().toISOString(),
      }, "return=minimal");

      const result = await applyAction(s.kind, payload, {
        actorMemberId: member.id,
        sourceType: s.source_type,
        sourceId: s.source_id,
        rationale: s.rationale,
      });

      await dbWrite(`ai_suggestions?id=eq.${s.id}`, "PATCH", {
        status: result.ok ? "applied" : "failed",
        applied_at: new Date().toISOString(),
        result: { detail: result.detail, data: result.data ?? null },
        error: result.ok ? null : result.detail,
      }, "return=minimal");

      await logActivity({
        entity_type: "suggestion", entity_id: s.id, actor_kind: "human", member_id: member.id,
        action: result.ok ? "suggestion_applied" : "suggestion_failed",
        summary: `${member.full_name} a approuvé : ${s.title} — ${result.detail}`,
        details: { kind: s.kind },
      });

      results.push({ id: s.id, status: result.ok ? "applied" : "failed", detail: result.detail });
    }

    return json({ ok: true, results }, 200, cors);
  } catch (err) {
    return json({ error: String(err) }, 500, cors);
  }
});
