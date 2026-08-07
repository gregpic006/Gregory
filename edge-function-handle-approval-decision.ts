Deno.serve(async (req) => {
  try {
    const { approval_id, decision } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const apRes = await fetch(
      `${supabaseUrl}/rest/v1/approvals?id=eq.${approval_id}&select=*,work_orders(description,worker_pay,units(unit_number,buildings(address)),service_requests(tenant_id,pending_reassessment,reassessment_due,ai_urgency,safety_override,tenants(full_name,email)))`,
      { headers: adminHeaders },
    );
    const [approval] = await apRes.json();
    if (!approval) {
      return new Response(JSON.stringify({ ok: false, error: "approval not found" }), { status: 404 });
    }

    const workOrder = approval.work_orders;
    const unit = workOrder?.units;
    const address = unit?.buildings?.address;
    const serviceRequest = workOrder?.service_requests;
    const tenant = serviceRequest?.tenants;

    if (!tenant?.email) {
      return new Response(JSON.stringify({ ok: false, error: "no tenant email" }), { status: 200 });
    }

    // Les faits (échéance de réévaluation, urgence, note du propriétaire)
    // viennent tous de la base — l'IA ne fait que les mettre en mots,
    // elle n'invente jamais la prochaine étape.
    const isUrgent = !!(serviceRequest?.safety_override || serviceRequest?.ai_urgency === "urgence" || serviceRequest?.ai_urgency === "élevé");
    const reassessmentDue = serviceRequest?.reassessment_due;
    const ownerNote = approval.rejection_note;

    const decisionContext = decision === "approved"
      ? "APPROUVÉE — les travaux sont autorisés et seront planifiés."
      : `REFUSÉE — le budget demandé n'est pas autorisé pour l'instant. Le dossier N'EST PAS fermé : ${
          isUrgent
            ? "étant donné l'urgence/le risque signalé, l'équipe Portail cherche une solution alternative (autre soumission, intervention partielle) sans délai."
            : `l'équipe Portail va obtenir une autre soumission ou évaluer une solution alternative, avec un suivi prévu d'ici le ${reassessmentDue || "prochains jours"}.`
        }${ownerNote ? ` Note du propriétaire à transmettre si pertinente pour le locataire : "${ownerNote}"` : ""}`;

    const prompt = `Tu es l'assistant du service à la clientèle de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Un propriétaire vient de prendre une décision au sujet d'une réparation demandée par un locataire. Rédige un courriel informant le locataire du résultat.

Décision: ${decisionContext}
Nom du locataire: ${tenant.full_name}
Adresse: ${address || ""} — Unité ${unit?.unit_number || ""}
Description des travaux demandés: ${workOrder?.description || ""}

RÈGLES STRICTES :
- N'invente JAMAIS de prochaine étape, de délai ou de solution qui n'est pas explicitement fournie ci-dessus. Utilise exactement les faits donnés dans "Décision".
- Si refusée, n'utilise pas de formule vague du type "une alternative sera étudiée" sans donner de détail concret — reprends l'information réelle fournie (délai de suivi, ou urgence traitée quand même).
- Reste professionnel et rassurant sur le ton, mais jamais vague sur le fond.

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "un objet de courriel court et professionnel en français",
  "body": "un courriel bref, poli et professionnel en français (3-5 phrases) informant le locataire de la décision et de la vraie prochaine étape. Signé 'L'équipe Portail'."
}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
      return new Response(JSON.stringify({ ok: false, error: "anthropic_api_error", detail: aiData }), { status: 502 });
    }
    const rawText = aiData.content?.[0]?.text ?? "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Portail <onboarding@mail.portailgestion.ca>",
        to: [tenant.email],
        subject: parsed.subject,
        text: parsed.body,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("handle-approval-decision unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
