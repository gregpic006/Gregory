// Rapprochement bancaire par import CSV/OFX (pas de connexion bancaire
// en temps réel — nécessiterait Plaid/Flinks, à brancher plus tard sur
// ce même moteur). Le matching est entièrement déterministe et produit
// un score de confiance (0-100) :
//   - >= 95 : rapprochement automatique (paiement marqué payé/partiel)
//   - 75-94 : suggestion dans l'admin, confirmation humaine requise
//   - < 75  : non attribué — l'IA tente une piste seulement à ce stade,
//             jamais appliquée automatiquement.
// Un montant négatif est traité comme un renversement/rejet et rouvre
// automatiquement le paiement visé.
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
    // Durcissement (Lot 7 TWIM) : ces en-têtes ne coûtent rien et
    // réduisent la surface d'attaque même si le contenu JSON renvoyé
    // n'est pas du HTML — défense en profondeur, pas une réaction à un
    // vecteur d'attaque identifié ici.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

const AMOUNT_TOLERANCE = 3; // écart en dollars toléré comme "exact" (frais/arrondis bancaires)

function daysBetween(d1: string, d2: string): number {
  return Math.round((new Date(d2).getTime() - new Date(d1).getTime()) / 86400000);
}

function normalize(s: string): string {
  return (s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ");
}

// Score de correspondance nom/description (0-25) — tolère les fautes de
// référence, un paiement fait par le conjoint (nom de famille seul), ou
// des initiales ("J TREJO").
function nameMatchScore(tenantName: string | undefined, description: string): number {
  if (!tenantName) return 0;
  const desc = normalize(description);
  const parts = normalize(tenantName).split(/\s+/).filter((p) => p.length >= 2);
  if (!parts.length) return 0;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (last.length >= 3 && desc.includes(last)) {
    return desc.includes(first) ? 25 : 20;
  }
  if (first.length >= 3 && desc.includes(first)) return 12;
  if (desc.includes(`${first[0]} ${last}`) || desc.includes(`${first[0]}${last}`)) return 20;
  return 0;
}

function scorePayment(payment: any, tx: { amount: number; date: string; description: string }, tenantName?: string) {
  const diff = tx.amount - Number(payment.amount);
  const amountScore = Math.abs(diff) <= AMOUNT_TOLERANCE ? 45 : diff < 0 ? 25 : 20;
  const days = Math.abs(daysBetween(payment.due_date, tx.date));
  const dateScore = days <= 2 ? 30 : days <= 5 ? 20 : days <= 10 ? 10 : 0;
  const nameScore = nameMatchScore(tenantName, tx.description);
  return Math.min(100, amountScore + dateScore + nameScore);
}

async function computeExternalId(ownerId: string, row: any): Promise<string> {
  if (row.reference) return `ref:${row.reference}`;
  if (row.id) return `id:${row.id}`;
  const raw = `${ownerId}|${row.date}|${row.amount}|${row.description || ""}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const adminHeaders = {
      apikey: serviceRoleKey ?? "",
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };

    // Appel système : la synchronisation Flinks (flinks-api.ts, action
    // sync_all/sync_now) réutilise ce même moteur de matching via
    // l'action "import_csv", sans JWT utilisateur — protégé par une clé
    // partagée (FLINKS_SYNC_SECRET) plutôt qu'une session admin.
    const systemKey = req.headers.get("x-flinks-sync-key") || "";
    const flinksSyncSecret = Deno.env.get("FLINKS_SYNC_SECRET");
    const isSystemCall = !!flinksSyncSecret && systemKey === flinksSyncSecret;

    let userId: string | null = null;
    if (!isSystemCall) {
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace("Bearer ", "");
      if (!jwt) {
        return new Response(JSON.stringify({ error: "Non authentifié" }), { status: 401, headers: corsHeaders });
      }
      const claims = await verifySupabaseJwt(jwt, Deno.env.get("SUPABASE_URL") ?? "");
      if (!claims) {
        return new Response(JSON.stringify({ error: "Jeton invalide ou expiré" }), { status: 401, headers: corsHeaders });
      }
      userId = claims.sub as string;

      const userRes = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=is_admin`, { headers: adminHeaders });
      const userRows = await userRes.json();
      if (!userRows?.[0]?.is_admin) {
        return new Response(JSON.stringify({ error: "Accès refusé — compte non admin" }), { status: 403, headers: corsHeaders });
      }
    }

    const logAudit = (action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/rest/v1/audit_log`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ actor_type: isSystemCall ? "system" : "admin", actor_id: userId, action, entity_type: entityType, entity_id: entityId, details }),
      });

    const notifyAdmins = async (subject: string, text: string) => {
      if (!resendKey) return;
      try {
        const adminsRes = await fetch(`${supabaseUrl}/rest/v1/users?is_admin=eq.true&select=email`, { headers: adminHeaders });
        const admins = await adminsRes.json().catch(() => []);
        const emails = Array.isArray(admins) ? admins.map((a: any) => a.email).filter(Boolean) : [];
        if (!emails.length) return;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "Portail <onboarding@mail.portailgestion.ca>", to: emails, subject, text }),
        });
      } catch (e) {
        console.error("Failed to notify admins", e);
      }
    };

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const { owner_id } = body;
      if (!owner_id) {
        return new Response(JSON.stringify({ error: "owner_id manquant" }), { status: 400, headers: corsHeaders });
      }
      const res = await fetch(
        `${supabaseUrl}/rest/v1/bank_transactions?owner_id=eq.${owner_id}&select=*,matched_payment:matched_payment_id(amount,due_date),ai_suggested_tenant:ai_suggested_tenant_id(full_name)&order=transaction_date.desc`,
        { headers: adminHeaders },
      );
      return new Response(JSON.stringify({ transactions: await res.json() }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action === "import_csv") {
      const { owner_id, rows } = body;
      if (!owner_id || !Array.isArray(rows)) {
        return new Response(JSON.stringify({ error: "owner_id et rows requis" }), { status: 400, headers: corsHeaders });
      }

      const buildingsRes = await fetch(`${supabaseUrl}/rest/v1/buildings?owner_id=eq.${owner_id}&select=id`, { headers: adminHeaders });
      const buildings = await buildingsRes.json();
      const buildingIds = buildings.map((b: any) => b.id);
      const buildingFilter = buildingIds.length ? `(${buildingIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";

      const unitsRes = await fetch(`${supabaseUrl}/rest/v1/units?building_id=in.${buildingFilter}&select=id`, { headers: adminHeaders });
      const units = await unitsRes.json();
      const unitIds = units.map((u: any) => u.id);
      const unitFilter = unitIds.length ? `(${unitIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)";

      const leasesRes = await fetch(`${supabaseUrl}/rest/v1/leases?unit_id=in.${unitFilter}&select=id,tenant_id,monthly_rent,tenants(full_name)`, { headers: adminHeaders });
      const leases = await leasesRes.json();
      const leaseFilter = leases.length ? `(${leases.map((l: any) => l.id).join(",")})` : "(00000000-0000-0000-0000-000000000000)";
      const tenantNameByLeaseId = new Map(leases.map((l: any) => [l.id, l.tenants?.full_name]));

      const paymentsRes = await fetch(`${supabaseUrl}/rest/v1/payments?lease_id=in.${leaseFilter}&status=in.(pending,late)&select=*`, { headers: adminHeaders });
      let candidatePayments: any[] = await paymentsRes.json();

      const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const recentPaidRes = await fetch(`${supabaseUrl}/rest/v1/payments?lease_id=in.${leaseFilter}&status=eq.paid&paid_date=gte.${sixtyDaysAgo}&select=*`, { headers: adminHeaders });
      const recentPaid: any[] = await recentPaidRes.json();

      const tenantNames: string[] = leases.map((l: any) => l.tenants?.full_name).filter(Boolean);
      const tenantIdByName = new Map(leases.map((l: any) => [l.tenants?.full_name, l.tenant_id]));

      const existingIdsRes = await fetch(`${supabaseUrl}/rest/v1/bank_transactions?owner_id=eq.${owner_id}&select=external_id`, { headers: adminHeaders });
      const existingIds = new Set(
        (await existingIdsRes.json().catch(() => [])).map((r: any) => r.external_id).filter(Boolean),
      );

      const patchPayment = (id: string, fields: Record<string, unknown>) =>
        fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify(fields) });

      const results = [];
      for (const row of rows) {
        const amount = Number(row.amount);
        const txDate = row.date;
        const description = row.description || "";
        if (!txDate || !amount) continue; // lignes invalides

        const externalId = await computeExternalId(owner_id, row);
        if (existingIds.has(externalId)) {
          results.push({ skipped: true, reason: "déjà importée", external_id: externalId, description, amount });
          continue;
        }
        existingIds.add(externalId);

        let matchStatus = "unmatched";
        let matchedPaymentId: string | null = null;
        let note: string | null = null;
        let confidence: number | null = null;
        let aiSuggestedTenantId: string | null = null;

        // ---- Montant négatif = renversement/rejet (NSF, dépôt annulé) ----
        if (amount < 0) {
          const absAmount = Math.abs(amount);
          const reversalMatch = recentPaid.find((p: any) => Math.abs(Number(p.amount) - absAmount) <= AMOUNT_TOLERANCE);
          matchStatus = "reversed";
          if (reversalMatch) {
            matchedPaymentId = reversalMatch.id;
            const isLate = new Date(reversalMatch.due_date) < new Date();
            await patchPayment(reversalMatch.id, {
              status: isLate ? "late" : "pending",
              paid_date: null,
              amount_received: Math.max(0, Number(reversalMatch.amount_received || reversalMatch.amount) - absAmount),
            });
            note = `Paiement renversé/rejeté (${absAmount} $) — dossier rouvert automatiquement.`;
            await notifyAdmins(
              "Paiement renversé — dossier rouvert",
              `Un dépôt de ${absAmount} $ a été renversé ou rejeté (${description}). Le paiement correspondant (échéance ${reversalMatch.due_date}) a été remis en statut ${isLate ? "en retard" : "en attente"} automatiquement.`,
            );
          } else {
            note = "Renversement/rejet détecté, mais aucun paiement correspondant trouvé — vérification manuelle requise.";
            await notifyAdmins("Renversement bancaire non identifié", `Un retrait de ${absAmount} $ (${description}) ressemble à un renversement mais ne correspond à aucun paiement payé récemment. Vérification manuelle requise.`);
          }
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/bank_transactions`, {
            method: "POST",
            headers: { ...adminHeaders, Prefer: "return=representation" },
            body: JSON.stringify({ owner_id, transaction_date: txDate, description, amount, match_status: matchStatus, matched_payment_id: matchedPaymentId, ai_suggestion_note: note, external_id: externalId }),
          });
          // Un conflit de clé unique (import concurrent de la même
          // transaction) renvoie un objet d'erreur, pas un tableau —
          // on l'ignore plutôt que de planter dessus.
          const insertedRows = insertRes.ok ? await insertRes.json().catch(() => []) : [];
          const inserted = Array.isArray(insertedRows) ? insertedRows[0] : null;
          if (inserted) results.push(inserted);
          else results.push({ skipped: true, reason: "conflit d'import concurrent", description, amount });
          continue;
        }

        // ---- Doublon exact déjà encaissé récemment (même montant, même bail, quelques jours d'écart) ----
        const dup = recentPaid.find((p: any) => Number(p.amount) === amount && p.paid_date && Math.abs(daysBetween(p.paid_date, txDate)) <= 3);

        // ---- Moteur de score déterministe ----
        const scored = candidatePayments
          .map((p) => ({ payment: p, score: scorePayment(p, { amount, date: txDate, description }, tenantNameByLeaseId.get(p.lease_id)) }))
          .sort((a, b) => b.score - a.score);
        const best = scored[0];
        const second = scored[1];
        const ambiguous = !!(second && best && best.score - second.score < 10 && second.score >= 75);

        if (dup && (!best || best.score < 95)) {
          matchStatus = "duplicate";
          matchedPaymentId = dup.id;
          note = `Un paiement du même montant (${amount} $) a déjà été reçu le ${dup.paid_date} pour ce bail — dépôt possiblement en double.`;
        } else if (best && best.score >= 95 && !ambiguous) {
          confidence = best.score;
          const payment = best.payment;
          const alreadyReceived = Number(payment.amount_received || 0);
          const totalReceived = alreadyReceived + amount;
          const owed = Number(payment.amount) - totalReceived;

          if (Math.abs(owed) <= AMOUNT_TOLERANCE) {
            matchStatus = "matched";
            matchedPaymentId = payment.id;
            await patchPayment(payment.id, { status: "paid", paid_date: txDate, amount_received: totalReceived });
            candidatePayments = candidatePayments.filter((p) => p.id !== payment.id);
            if (alreadyReceived > 0) note = `Paiement complété par versements (cumul ${totalReceived} $, ex: colocataires).`;
          } else if (owed > AMOUNT_TOLERANCE) {
            // Reçu partiel — le bail reste en attente, mais le cumul est enregistré
            // pour qu'un second versement (ex: colocataire) puisse le compléter.
            matchStatus = "partial";
            matchedPaymentId = payment.id;
            await patchPayment(payment.id, { amount_received: totalReceived });
            payment.amount_received = totalReceived; // reflète le cumul pour une 2e ligne du même import
            note = `Paiement partiel : ${amount} $ reçu, ${owed.toFixed(2)} $ restant sur ${payment.amount} $.`;
          } else {
            // Excédent : vérifier si ça correspond à 2 mois payés d'avance
            const twoMonths = Number(payment.amount) * 2;
            const nextMonth = candidatePayments.find(
              (p) => p.lease_id === payment.lease_id && p.id !== payment.id && daysBetween(payment.due_date, p.due_date) > 0 && daysBetween(payment.due_date, p.due_date) <= 35,
            );
            if (nextMonth && Math.abs(amount - twoMonths) <= AMOUNT_TOLERANCE) {
              matchStatus = "matched";
              matchedPaymentId = payment.id;
              await patchPayment(payment.id, { status: "paid", paid_date: txDate, amount_received: payment.amount });
              await patchPayment(nextMonth.id, { status: "paid", paid_date: txDate, amount_received: nextMonth.amount });
              candidatePayments = candidatePayments.filter((p) => p.id !== payment.id && p.id !== nextMonth.id);
              note = `Ce dépôt couvre 2 échéances (${payment.due_date} et ${nextMonth.due_date}).`;
            } else {
              matchStatus = "overpaid";
              matchedPaymentId = payment.id;
              await patchPayment(payment.id, { status: "paid", paid_date: txDate, amount_received: totalReceived });
              candidatePayments = candidatePayments.filter((p) => p.id !== payment.id);
              note = `Excédent de ${Math.abs(owed).toFixed(2)} $ par rapport au loyer attendu (${payment.amount} $) — possiblement stationnement/garage inclus.`;
            }
          }
        } else if (best && best.score >= 75) {
          matchStatus = "suggested";
          matchedPaymentId = best.payment.id;
          confidence = best.score;
          note = ambiguous
            ? `Plusieurs baux correspondent à ce dépôt (${best.score}% vs ${second.score}%) — confirmation requise.`
            : `Correspondance probable (${best.score}%) — à confirmer avant application.`;
        } else {
          confidence = best?.score ?? null;
        }

        // ---- IA en dernier recours, seulement si aucune règle déterministe n'a suffi ----
        if (matchStatus === "unmatched" && tenantNames.length && anthropicKey) {
          const aiStartedAt = Date.now();
          try {
            const prompt = `Tu es l'assistant de rapprochement bancaire de "Portail". Voici un dépôt bancaire dont l'origine n'est pas claire à partir des règles déterministes (montant, date, nom).

Description bancaire : "${description}"
Montant : ${amount} $
Date : ${txDate}

Locataires actifs de ce propriétaire : ${tenantNames.join(", ")}

Réponds UNIQUEMENT avec un objet JSON valide (rien avant, rien après):
{
  "suggested_tenant_name": "le nom exact d'un locataire de la liste ci-dessus si la description bancaire y fait clairement référence, sinon null — ne devine jamais sans indice textuel réel",
  "confidence": un nombre entre 0 et 100,
  "note": "une phrase expliquant ton raisonnement, ou pourquoi ce dépôt ne peut pas être identifié"
}`;
            const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
              body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
            });
            const aiData = await aiRes.json();
            const rawText = aiData.content?.[0]?.text ?? "{}";
            const parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
            if (parsed.suggested_tenant_name && tenantIdByName.has(parsed.suggested_tenant_name)) {
              aiSuggestedTenantId = tenantIdByName.get(parsed.suggested_tenant_name) ?? null;
            }
            note = parsed.note ?? note;

            await fetch(`${supabaseUrl}/rest/v1/ai_run_log`, {
              method: "POST", headers: adminHeaders,
              body: JSON.stringify({
                function_name: "reconcile-bank-transactions", trigger_source: "admin_csv_import", entity_type: "bank_transactions",
                prompt_version: "bank-reconciliation-v2-scored", model_version: "claude-haiku-4-5-20251001",
                input_summary: `${description} — ${amount} $`, output_summary: parsed.suggested_tenant_name ?? "aucune piste",
                confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
                needs_escalation: true,
                duration_ms: Date.now() - aiStartedAt,
                input_tokens: aiData?.usage?.input_tokens ?? null, output_tokens: aiData?.usage?.output_tokens ?? null,
                automatic_action_taken: "suggestion_seulement_aucune_application_automatique",
              }),
            }).catch(() => null);
          } catch (e) {
            console.error("AI bank description suggestion failed", e);
          }
        }

        const insertRes = await fetch(`${supabaseUrl}/rest/v1/bank_transactions`, {
          method: "POST",
          headers: { ...adminHeaders, Prefer: "return=representation" },
          body: JSON.stringify({
            owner_id, transaction_date: txDate, description, amount,
            match_status: matchStatus, matched_payment_id: matchedPaymentId, match_confidence: confidence,
            ai_suggested_tenant_id: aiSuggestedTenantId, ai_suggestion_note: note, external_id: externalId,
          }),
        });
        const insertedRows = insertRes.ok ? await insertRes.json().catch(() => []) : [];
        const inserted = Array.isArray(insertedRows) ? insertedRows[0] : null;
        if (inserted) results.push(inserted);
        else results.push({ skipped: true, reason: "conflit d'import concurrent", description, amount });
      }

      await logAudit("bank_reconciliation.import", "bank_transactions", null, { owner_id, count: rows.length });
      return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: corsHeaders });
    }

    if (action === "confirm_match") {
      const { transaction_id, payment_id } = body;
      if (!transaction_id || !payment_id) {
        return new Response(JSON.stringify({ error: "Paramètres manquants" }), { status: 400, headers: corsHeaders });
      }
      const txRes = await fetch(`${supabaseUrl}/rest/v1/bank_transactions?id=eq.${transaction_id}&select=*`, { headers: adminHeaders });
      const [tx] = await txRes.json();
      if (!tx) {
        return new Response(JSON.stringify({ error: "Transaction introuvable" }), { status: 404, headers: corsHeaders });
      }
      const paymentRes = await fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${payment_id}&select=amount,amount_received`, { headers: adminHeaders });
      const [payment] = await paymentRes.json();
      const totalReceived = Number(payment?.amount_received || 0) + Number(tx.amount);
      await fetch(`${supabaseUrl}/rest/v1/payments?id=eq.${payment_id}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "paid", paid_date: tx.transaction_date, amount_received: totalReceived }),
      });
      await fetch(`${supabaseUrl}/rest/v1/bank_transactions?id=eq.${transaction_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ match_status: "matched", matched_payment_id: payment_id, reconciled_by: userId, reconciled_at: new Date().toISOString() }),
      });
      await logAudit("bank_reconciliation.manual_match", "bank_transactions", transaction_id, { payment_id });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    if (action === "ignore_transaction") {
      const { transaction_id } = body;
      if (!transaction_id) {
        return new Response(JSON.stringify({ error: "transaction_id manquant" }), { status: 400, headers: corsHeaders });
      }
      await fetch(`${supabaseUrl}/rest/v1/bank_transactions?id=eq.${transaction_id}`, {
        method: "PATCH", headers: adminHeaders,
        body: JSON.stringify({ match_status: "ignored", reconciled_by: userId, reconciled_at: new Date().toISOString() }),
      });
      await logAudit("bank_reconciliation.ignore", "bank_transactions", transaction_id, {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "action inconnue" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    console.error("reconcile-bank-transactions unexpected error", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
