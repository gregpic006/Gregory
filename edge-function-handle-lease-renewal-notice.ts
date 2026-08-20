// Avis de renouvellement/augmentation/non-renouvellement de bail.
// Les dates et délais légaux viennent de lease_renewal_tracking (calcul
// déterministe selon le Code civil du Québec) — jamais de l'IA. Pour
// une augmentation, le montant DOIT être fourni par l'admin (calculé
// selon la méthode réglementaire du TAL, hors de ce système). L'IA se
// limite à rédiger la lettre à partir de faits déjà déterminés, et un
// avertissement légal fixe (non généré par l'IA) est toujours ajouté.
// Le locataire signe désormais lui-même électroniquement via le lien
// envoyé ci-dessous (voir handle-lease-signature.ts / signer-bail.html) —
// décision produit confirmée le 2026-08-14. record_response reste
// disponible pour que l'admin consigne une réponse obtenue autrement
// (ex. verbale), mais n'est plus le chemin principal.
// Liste blanche d'origines : évite d'exposer les fonctions à un
// site tiers qui embarquerait un appel authentifié depuis le
// navigateur d'un usager (CSRF via fetch). Les appels serveur à
// serveur (cron, webhooks, autre fonction edge) n'envoient pas
// d'en-tête Origin et ne sont donc pas affectés par ce contrôle.
const ALLOWED_ORIGINS = ["https://portailgestion.ca", "https://www.portailgestion.ca"];
function corsHeadersFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

const SITE_BASE_URL = "https://portailgestion.ca";

const LEGAL_DISCLAIMER = "Cet avis est transmis à titre informatif dans le cadre de la gestion de votre logement. Il ne remplace pas vos droits prévus au Code civil du Québec : si vous souhaitez refuser une augmentation de loyer ou une modification des conditions du bail, vous devez aviser le propriétaire par écrit dans le délai d'un mois suivant la réception du présent avis, à défaut de quoi vous serez réputé avoir accepté. Pour toute question sur vos droits, vous pouvez consulter le Tribunal administratif du logement (tal.gouv.qc.ca).";

// Vérifie la signature du JWT (HS256, secret du projet Supabase) au lieu
// de se fier uniquement au réglage "Verify JWT" de la plateforme —
// défense en profondeur : cette fonction reste sûre même si ce réglage
// est mal configuré pour une fonction en particulier.
// Vérifie le JWT en le faisant valider par le service Auth de Supabase
// lui-même (GET /auth/v1/user) plutôt qu'en réimplémentant la
// cryptographie de vérification. La passerelle Edge Functions a un bug
// connu qui rejette à tort les JWT signés en ES256 quand verify_jwt=true
// est réglé au niveau plateforme (github.com/supabase/supabase/issues/42244)
// — d'où verify_jwt=false dans supabase/config.toml pour cette fonction :
// ce code est maintenant la seule vérification, et s'appuie sur l'API
// Auth de Supabase, qui elle gère ES256 correctement.
async function verifySupabaseJwt(jwt: string, supabaseUrl: string): Promise<{ sub: string; [key: string]: unknown } | null> {
  if (!jwt) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      },
    });
    if (!res.ok) return null;
    const user = await res.json().catch(() => null);
    if (!user?.id) return null;
    return { sub: user.id, ...user };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
    }
    const claims = await verifySupabaseJwt(jwt, Deno.env.get("SUPABASE_URL") ?? "");
    if (!claims) {
      return new Response(JSON.stringify({ error: "Jeton invalide ou expiré" }), { status: 401, headers: corsHeaders });
    }
    const userId = claims.sub as string;

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
      // Un nouveau token de signature est généré à chaque envoi d'avis (y
      // compris un renvoi) : invalide tout lien précédemment transmis.
      const signatureToken = crypto.randomUUID();
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

      // La signature électronique n'a de sens que si le locataire doit
      // manifester son accord (renouvellement, augmentation) — pas pour
      // un non-renouvellement, qui est une simple notification.
      const signatureUrl = `${SITE_BASE_URL}/signer-bail.html?lease=${lease_id}&token=${signatureToken}`;
      const signatureLine = notice_type !== "non_renouvellement"
        ? `\n\nPour confirmer votre accord, signez électroniquement ici : ${signatureUrl}`
        : "";

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@mail.portailgestion.ca>",
          to: [tenant.email],
          subject: parsed.subject,
          text: `${parsed.body}${signatureLine}\n\n---\n${LEGAL_DISCLAIMER}`,
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
          renewal_signed: false,
          renewal_signed_at: null,
          renewal_signature_token: notice_type !== "non_renouvellement" ? signatureToken : null,
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
