// Signature électronique du renouvellement de bail par le locataire —
// accès public (comme confirmer-reparation.html), protégé uniquement par
// le token à usage unique lease.renewal_signature_token. Décision produit
// confirmée par le client (2026-08-14) : la signature est immédiatement
// finale, sans validation admin après coup. Le token est invalidé dès
// l'enregistrement de la signature pour empêcher toute réutilisation du
// lien.
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

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const body = await req.json().catch(() => ({}));
    const { lease_id, token, action } = body;
    if (!lease_id || !token) {
      return new Response(JSON.stringify({ error: "lease_id et token requis" }), { status: 400, headers: corsHeaders });
    }

    const leaseRes = await fetch(
      `${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}&select=*,tenants(full_name,email),units(unit_number,buildings(address))`,
      { headers: adminHeaders },
    );
    const [lease] = await leaseRes.json();
    if (!lease || !lease.renewal_signature_token || lease.renewal_signature_token !== token) {
      return new Response(JSON.stringify({ error: "Lien invalide ou expiré" }), { status: 404, headers: corsHeaders });
    }
    if (!lease.renewal_notice_sent_at) {
      return new Response(JSON.stringify({ error: "Aucun avis de renouvellement en attente pour ce bail" }), { status: 404, headers: corsHeaders });
    }
    if (lease.renewal_signed) {
      return new Response(JSON.stringify({ error: "Ce bail a déjà été signé", already_signed: true }), { status: 409, headers: corsHeaders });
    }

    if (action === "get") {
      const factsLabel = lease.renewal_notice_type === "augmentation"
        ? `Augmentation du loyer mensuel de ${lease.monthly_rent} $ à ${lease.renewal_notice_amount} $, à compter du ${lease.end_date}.`
        : lease.renewal_notice_type === "non_renouvellement"
        ? `Le bail ne sera pas renouvelé à son échéance (${lease.end_date}).`
        : `Renouvellement du bail aux mêmes conditions (loyer inchangé à ${lease.monthly_rent} $), à compter du ${lease.end_date}.`;

      return new Response(JSON.stringify({
        tenant_name: lease.tenants?.full_name || "",
        address: lease.units?.buildings?.address || "",
        unit_number: lease.units?.unit_number || "",
        notice_type: lease.renewal_notice_type,
        facts_label: factsLabel,
      }), { status: 200, headers: corsHeaders });
    }

    if (action === "sign") {
      const { signature_image, signer_name } = body;
      if (!signature_image || typeof signature_image !== "string" || !signature_image.startsWith("data:image/png;base64,")) {
        return new Response(JSON.stringify({ error: "Signature manquante ou invalide" }), { status: 400, headers: corsHeaders });
      }
      if (!signer_name || typeof signer_name !== "string" || !signer_name.trim()) {
        return new Response(JSON.stringify({ error: "Nom du signataire requis" }), { status: 400, headers: corsHeaders });
      }

      const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "inconnue";
      const userAgent = req.headers.get("user-agent") || "";
      const signedAt = new Date().toISOString();

      const insertRes = await fetch(`${supabaseUrl}/rest/v1/lease_signatures`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          lease_id,
          notice_type: lease.renewal_notice_type,
          signature_image,
          signer_name: signer_name.trim(),
          ip_address: ipAddress,
          user_agent: userAgent,
          signed_at: signedAt,
        }),
      });
      if (!insertRes.ok) {
        console.error("Failed to insert lease_signatures", await insertRes.text());
        return new Response(JSON.stringify({ error: "Impossible d'enregistrer la signature, réessaie." }), { status: 500, headers: corsHeaders });
      }

      // renewal_signature_token remis à null : invalide définitivement ce lien.
      await fetch(`${supabaseUrl}/rest/v1/leases?id=eq.${lease_id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          renewal_signed: true,
          renewal_response: "accepted",
          renewal_signed_at: signedAt,
          renewal_signature_ip: ipAddress,
          renewal_signature_token: null,
        }),
      });

      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          actor_type: "tenant",
          actor_id: null,
          action: "lease_renewal.signed_by_tenant",
          entity_type: "leases",
          entity_id: lease_id,
          details: { signer_name: signer_name.trim(), ip_address: ipAddress, notice_type: lease.renewal_notice_type },
        }),
      }).catch((e) => console.error("Failed to write audit_log", e));

      if (lease.tenants?.email && resendKey) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Portail <onboarding@mail.portailgestion.ca>",
            to: [lease.tenants.email],
            subject: "Confirmation de signature — renouvellement de bail",
            text: `Bonjour ${lease.tenants.full_name || ""},\n\nNous confirmons la réception de votre signature électronique concernant le renouvellement de votre bail au ${lease.units?.buildings?.address || ""}, unité ${lease.units?.unit_number || ""}, signée le ${new Date(signedAt).toLocaleString("fr-CA")}.\n\nCeci constitue une confirmation officielle. Conservez ce courriel pour vos dossiers.\n\n— L'équipe Portail`,
          }),
        }).catch((e) => console.error("Failed to send signature confirmation email", e));
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("handle-lease-signature unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
