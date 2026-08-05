// Avis de renouvellement/augmentation/non-renouvellement de bail.
// Les dates et délais légaux viennent de lease_renewal_tracking (calcul
// déterministe selon le Code civil du Québec) — jamais de l'IA. Pour
// une augmentation, le montant DOIT être fourni par l'admin (calculé
// selon la méthode réglementaire du TAL, hors de ce système). L'IA se
// limite à rédiger la lettre à partir de faits déjà déterminés, et un
// avertissement légal fixe (non généré par l'IA) est toujours ajouté.
// La réponse et la signature du locataire sont enregistrées
// manuellement par l'admin, pas via un flux public automatisé — ce
// sont des actes à portée légale.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LEGAL_DISCLAIMER = "Cet avis est transmis à titre informatif dans le cadre de la gestion de votre logement. Il ne remplace pas vos droits prévus au Code civil du Québec : si vous souhaitez refuser une augmentation de loyer ou une modification des conditions du bail, vous devez aviser le propriétaire par écrit dans le délai d'un mois suivant la réception du présent avis, à défaut de quoi vous serez réputé avoir accepté. Pour toute question sur vos droits, vous pouvez consulter le Tribunal administratif du logement (tal.gouv.qc.ca).";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const payloadBase64 = jwt.split(".")[1];
    const claims = JSON.parse(atob(payloadBase64.replace(/-/g, "+").replace(/_/g, "/")));
    const userId = claims.sub;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
    const userRows = await userRes.json();
    if (!userRows?.[0]?.is_admin) {
      return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
    }

    const logAudit = (action: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: "admin", actor_id: userId, action, entity_type: "leases", entity_id: entityId, details }),
      });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/lease_renewal_tracking?select=*,leases(tenants(full_name,email),units(unit_number,buildings(address)))&order=end_date.asc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ leases: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "send_notice") {
      const { lease_id, notice_type, new_rent_amount, message } = body;
      if (!lease_id || !notice_type) {
        return new Response(JSON.stringify({ error: "lease_id et notice_type requis" }), { status: 400, headers: corsHeaders });
      }
      if (notice_type === "augmentation" && !(Number(new_rent_amount) > 0)) {
        return new Response(JSON.stringify({ error: "new_rent_amount requis et calculé selon la méthode du TAL pour une augmentation — ce système ne le calcule pas automatiquement" }), { status: 400, headers: corsHeaders });
      }

      const leaseRes = await fetch(
        `${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}&select=*,tenants(full_name,email),units(unit_number,buildings(address))`,
        { headers: adminHeaders },
      );
      const [lease] = await leaseRes.json();
      if (!lease) {
        return new Response(JSON.stringify({ error: "Bail introuvable" }), { status: 404, headers: corsHeaders });
      }
      const tenant = lease.tenants;
      if (!tenant?.email) {
        return new Response(JSON.stringify({ error: "Aucun courriel pour ce locataire" }), { status: 400, headers: corsHeaders });
      }

      const factsLabel = notice_type === "augmentation"
        ? `Augmentation du loyer mensuel de ${lease.monthly_rent} $ à ${new_rent_amount} $, à compter du renouvellement du bail (${lease.end_date}).`
        : notice_type === "non_renouvellement"
        ? `Le bail ne sera pas renouvelé à son échéance (${lease.end_date}).`
        : `Renouvellement du bail aux mêmes conditions (loyer inchangé à ${lease.monthly_rent} $), à compter du ${lease.end_date}.`;

      const prompt = `Tu es l'assistant de gestion locative de "Portail", au Québec. Rédige un avis à un locataire à propos de son bail. Utilise UNIQUEMENT les faits fournis ci-dessous — n'invente aucune date, aucun montant, aucune règle légale.

Locataire : ${tenant.full_name}
Adresse : ${lease.units?.buildings?.address || ""} — Unité ${lease.units?.unit_number || ""}
Fin du bail actuel : ${lease.end_date}
Décision : ${factsLabel}
${message ? `Message additionnel du gestionnaire : ${message}` : ""}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "objet de courriel court et professionnel en français",
  "body": "corps du courriel en français (4-6 phrases), professionnel et clair, qui communique exactement la décision ci-dessus sans ajouter de détail non fourni. Signé 'L'équipe Portail'."
}`;

      const aiStartedAt = Date.now();
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
      });
      const aiData = await aiRes.json();
      if (!aiRes.ok) {
        console.error("Anthropic API error", aiRes.status, JSON.stringify(aiData));
        await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
          method: "POST", headers: adminHeaders,
          body: JSON.stringify({
            function_name: "handle-lease-renewal-notice", trigger_source: "admin_portal", entity_type: "leases", entity_id: lease_id,
            prompt_version: "lease-renewal-notice-v1", model_version: "claude-haiku-4-5-20251001", input_summary: factsLabel,
            duration_ms: Date.now() - aiStartedAt, error: `anthropic_api_error ${aiRes.status}`,
          }),
        }).catch(() => null);
        return new Response(JSON.stringify({ error: "Erreur du service IA" }), { status: 502, headers: corsHeaders });
      }
      const rawText = aiData.content?.[0]?.text ?? "{}";
      const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());

      await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          function_name: "handle-lease-renewal-notice",
          trigger_source: "admin_portal",
          entity_type: "leases",
          entity_id: lease_id,
          prompt_version: "lease-renewal-notice-v1",
          model_version: "claude-haiku-4-5-20251001",
          input_summary: factsLabel,
          output_summary: parsed.subject ?? null,
          duration_ms: Date.now() - aiStartedAt,
          input_tokens: aiData?.usage?.input_tokens ?? null,
          output_tokens: aiData?.usage?.output_tokens ?? null,
          automatic_action_taken: `avis_${notice_type}_envoye`,
        }),
      }).catch((e) => console.error("Failed to write ai_run_log", e));

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@resend.dev>",
          to: [tenant.email],
          subject: parsed.subject,
          text: `${parsed.body}\n\n---\n${LEGAL_DISCLAIMER}`,
        }),
      });

      await fetch(`${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          renewal_notice_sent_at: new Date().toISOString(),
          renewal_notice_type: notice_type,
          renewal_notice_amount: notice_type === "augmentation" ? Number(new_rent_amount) : null,
          renewal_deadline_missed: false,
        }),
      });

      await logAudit("lease_renewal.notice_sent", lease_id, { notice_type, new_rent_amount: new_rent_amount || null });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "record_response") {
      const { lease_id, renewal_response, renewal_signed, renewal_response_note } = body;
      if (!lease_id) {
        return new Response(JSON.stringify({ error: "lease_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          renewal_response: renewal_response || undefined,
          renewal_signed: renewal_signed ?? undefined,
          renewal_response_note: renewal_response_note ?? undefined,
        }),
      });
      await logAudit("lease_renewal.response_recorded", lease_id, { renewal_response, renewal_signed, renewal_response_note });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("handle-lease-renewal-notice unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
