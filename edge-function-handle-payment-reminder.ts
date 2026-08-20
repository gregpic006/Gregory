Deno.serve(async (req) => {
  try {
    const { payment_id, reminder_type } = await req.json();

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    const payRes = await fetch(
      `${supabaseUrl}/rest/v1/payments?id=eq.${payment_id}&select=*,leases(monthly_rent,tenants(full_name,email),units(unit_number,buildings(address)))`,
      { headers: adminHeaders },
    );
    const [payment] = await payRes.json();
    if (!payment) {
      return new Response(JSON.stringify({ ok: false, error: "payment not found" }), { status: 404 });
    }

    // Garde-fou : si une entente a été conclue entretemps (pause activée
    // par un admin/propriétaire), on n'envoie plus rien — vérifié ici en
    // plus du filtre SQL, au cas où l'appel viendrait d'ailleurs.
    if (payment.reminder_paused) {
      return new Response(JSON.stringify({ ok: true, skipped: "reminder_paused" }), { status: 200 });
    }

    const tenant = payment.leases?.tenants;
    const unit = payment.leases?.units;
    const address = unit?.buildings?.address;

    if (!tenant?.email) {
      return new Response(JSON.stringify({ ok: false, error: "no tenant email" }), { status: 200 });
    }

    // Type "escalate" : on cesse d'écrire au locataire (3 rappels déjà
    // envoyés sans paiement) et on avise un humain — pas d'IA ici,
    // seulement un constat factuel des données déjà connues.
    if (reminder_type === "escalate") {
      try {
        const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
        const admins = await adminsRes.json().catch(() => []);
        const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
        if (adminEmails.length && resendKey) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Portail <onboarding@mail.portailgestion.ca>",
              to: adminEmails,
              subject: `Suivi humain requis — loyer impayé, unité ${unit?.unit_number || ""}`,
              text: `${tenant.full_name} (${tenant.email}) n'a pas payé le loyer dû le ${payment.due_date} (${payment.amount} $) malgré 3 rappels automatiques envoyés à ${address || ""}, unité ${unit?.unit_number || ""}.\n\nAucun autre rappel automatique ne sera envoyé à ce locataire pour ce paiement. Un suivi humain (appel, entente, mise en demeure si applicable) est requis.`,
            }),
          });
        }
      } catch (e) {
        console.error("Failed to send escalation email", e);
      }

      await fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          actor_type: "system",
          action: "payment_reminder_escalated",
          entity_type: "payments",
          entity_id: payment_id,
          details: { tenant_email: tenant.email, amount: payment.amount, due_date: payment.due_date },
        }),
      });

      return new Response(JSON.stringify({ ok: true, escalated: true }), { status: 200 });
    }

    // Numéro de séquence pour l'historique (ex: "rappel 2 sur 3").
    const historyRes = await fetch(`${supabaseUrl}/rest/v1/payment_reminders?payment_id=eq.${payment_id}&select=id`, { headers: adminHeaders });
    const history = await historyRes.json().catch(() => []);
    const sequenceNumber = (Array.isArray(history) ? history.length : 0) + 1;

    // Minimisation (Loi 25) : rédiger un rappel générique n'exige pas le
    // nom ni l'adresse du locataire — le destinataire les connaît déjà.
    const prompt = `Tu es l'assistant du service à la clientèle de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Rédige un courriel de rappel de paiement de loyer à un locataire.

Type de rappel: ${reminder_type === "late" ? "Le paiement est EN RETARD (déjà passé la date d'échéance)" : "Le paiement arrive bientôt à échéance (rappel préventif)"}
Numéro de ce rappel pour ce paiement: ${sequenceNumber}
Montant: ${payment.amount} $
Date d'échéance: ${payment.due_date}

RÈGLES STRICTES (ne jamais les enfreindre) :
- Ne mentionne JAMAIS de conséquence juridique, éviction, poursuite, pénalité, intérêt ou frais de retard — ces informations ne sont pas fournies et ne doivent jamais être inventées.
- Ne menace jamais le locataire, même à un rappel avancé. Le ton reste professionnel et respectueux en tout temps.
- Si le locataire doit régulariser sa situation ou a des questions, invite-le simplement à contacter l'équipe Portail — ne présume jamais de la procédure applicable.

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "subject": "un objet de courriel court et professionnel en français",
  "body": "un courriel bref, poli et professionnel en français (3-4 phrases). Si c'est un retard, reste courtois mais clair sur l'importance de régulariser rapidement et d'entrer en contact si besoin. Si c'est préventif, ton simplement informatif et amical. Signé 'L'équipe Portail'."
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

    // Portail Concierge — en plus du courriel, un SMS pour un retard
    // réel (pas pour le rappel préventif) : message court et
    // déterministe (pas rédigé par l'IA, contrairement au courriel).
    // Tant qu'aucun compte Twilio n'est branché, send-sms.ts bascule
    // automatiquement sur un courriel de secours — ne bloque jamais ce
    // flux et n'a pas besoin d'être modifié une fois le compte ajouté.
    if (reminder_type === "late" && tenant.phone) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: serviceRoleKey ?? "", Authorization: `Bearer ${serviceRoleKey}` },
          body: JSON.stringify({
            to_phone: tenant.phone,
            message: `Portail : votre loyer de ${payment.amount} $ (échéance ${payment.due_date}) est en retard. Merci de nous contacter si besoin. — Portail`,
            entity_type: "payments",
            entity_id: payment_id,
            fallback_email: tenant.email,
            fallback_subject: "Rappel — loyer en retard (SMS non livré)",
          }),
        });
      } catch (e) {
        console.error("Failed to trigger send-sms", e);
      }
    }

    // Historique complet — sert d'audit et de base pour le plafond de fréquence.
    await fetch(`${supabaseUrl}/rest/v1/payment_reminders`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        payment_id,
        reminder_type,
        sequence_number: sequenceNumber,
        recipient: tenant.email,
        subject: parsed.subject,
        body: parsed.body,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("handle-payment-reminder unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
