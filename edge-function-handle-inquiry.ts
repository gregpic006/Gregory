Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload.record;

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Minimisation (Loi 25) : catégoriser, résumer et rédiger une réponse
    // n'exige pas de savoir QUI a écrit — seulement CE QUI est écrit. Le
    // nom/courriel/téléphone ne sont donc jamais envoyés à l'IA ; ils
    // restent disponibles pour le courriel à l'équipe et l'écran admin,
    // construits localement plus bas à partir de `record` directement.
    const prompt = `Tu es l'assistant du service à la clientèle de "Portail", une entreprise de gestion immobilière résidentielle au Québec. Un formulaire a été soumis sur le site public. Ce courriel est envoyé AUTOMATIQUEMENT, sans relecture humaine avant l'envoi.

Type de demande: ${record.type === "visite" ? "Demande de visite pour un logement" : "Propriétaire souhaitant confier son immeuble en gestion"}
Message: ${record.message || "(aucun message)"}

RÈGLES STRICTES (ce courriel part sans relecture humaine — ne jamais les enfreindre) :
- Ne garantis JAMAIS l'acceptation d'un mandat de gestion — dis seulement qu'un membre de l'équipe communiquera avec la personne pour la suite.
- Ne confirme JAMAIS la disponibilité d'un logement précis — dis que la disponibilité sera confirmée par l'équipe.
- Ne propose ni ne confirme JAMAIS une heure de visite précise — invite la personne à discuter des disponibilités avec l'équipe, sans t'engager sur un horaire.
- Ne donne JAMAIS de prix contractuel final (loyer, frais de gestion) — seulement des estimations clairement qualifiées de préliminaires.
- N'accepte JAMAIS une condition particulière mentionnée dans le message (ex: modalités de paiement spéciales, animaux, sous-location) — indique que ces questions seront étudiées par l'équipe, sans dire oui ou non.
- Ne refuse JAMAIS un candidat ou une demande — ce courriel est toujours une confirmation de réception, jamais un refus.
- Si des informations importantes manquent pour traiter la demande (ex: date souhaitée, adresse précise), tu peux les demander poliment dans le courriel.

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après), avec exactement ces champs:
{
  "category": "une courte étiquette de catégorisation en français",
  "summary": "un résumé en 1-2 phrases en français, à l'intention du gestionnaire",
  "reply_subject": "un objet de courriel court et professionnel en français",
  "reply_body": "un courriel de réponse chaleureux, professionnel et concis en français (3-5 phrases), qui confirme la réception de la demande, indique qu'un membre de l'équipe la contactera bientôt, pose une question sur une information manquante si pertinent, et est signé 'L'équipe Portail'",
  "estimated_units": "si le message mentionne le nombre de logements de l'immeuble, ce nombre (entier) ; sinon null",
  "estimated_monthly_rent": "si le message permet d'estimer le loyer mensuel TOTAL de l'immeuble (somme de tous les logements), ce montant en dollars (nombre) ; sinon null"
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
        max_tokens: 1024,
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

    const managementRate = 0.06;
    let replyBody = parsed.reply_body;
    if (record.type === "mandat" && typeof parsed.estimated_monthly_rent === "number") {
      const monthlyFee = Math.round(parsed.estimated_monthly_rent * managementRate * 100) / 100;
      const unitsLine = typeof parsed.estimated_units === "number"
        ? `pour ${parsed.estimated_units} logement(s), `
        : "";
      replyBody += `\n\nEstimation préliminaire, sous réserve de la validation de l'immeuble et du mandat (${unitsLine}à confirmer avec un membre de notre équipe) : au taux de gestion de 6% du loyer perçu, les frais de gestion mensuels estimés seraient d'environ ${monthlyFee.toLocaleString("fr-CA")} $ sur un loyer total estimé de ${parsed.estimated_monthly_rent.toLocaleString("fr-CA")} $. Ce chiffre n'est pas un prix contractuel final.`;
    }

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Portail <onboarding@mail.portailgestion.ca>",
        to: [record.email],
        subject: parsed.reply_subject,
        text: replyBody,
      }),
    });

    // Avant ce correctif, une demande "mandat" (devenir client) recevait
    // une réponse automatique au prospect mais l'équipe n'était jamais
    // avisée — seul le compteur "Nouvelles demandes" du tableau de bord
    // bougeait, sans aucun écran pour voir le détail. Un lead pouvait se
    // perdre en silence. Avise maintenant l'équipe par courriel pour
    // chaque demande, quel que soit le type.
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };
    const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
    const admins = await adminsRes.json().catch(() => []);
    const adminEmails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
    if (adminEmails.length && resendKey) {
      const typeLabel = record.type === "visite" ? "Demande de visite" : "Demande de mandat (nouveau client potentiel)";
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Portail <onboarding@mail.portailgestion.ca>",
          to: adminEmails,
          subject: `${typeLabel} — ${record.full_name}`,
          text: `${typeLabel}\n\nNom : ${record.full_name}\nCourriel : ${record.email}\nTéléphone : ${record.phone || "non fourni"}\nMessage : ${record.message || "(aucun)"}\n\nCatégorie IA : ${parsed.category}\nRésumé : ${parsed.summary}\n\nUne réponse automatique a déjà été envoyée au prospect. Consulte le portail admin pour le détail complet et faire le suivi.`,
        }),
      });
    }

    await fetch(`${supabaseUrl}/rest/v1/inquiries?id=eq.${record.id}`, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey ?? "",
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        ai_category: parsed.category,
        ai_summary: replyBody.includes("frais de gestion")
          ? `${parsed.summary} (estimation incluse dans la réponse : ${replyBody.split("Estimation préliminaire")[1]?.trim() || ""})`
          : parsed.summary,
        ai_reply_sent: true,
      }),
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    console.error("handle-inquiry unexpected error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
