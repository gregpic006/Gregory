// Diagnostic de bout en bout pour Portail.
// Exécuté via GitHub Actions (workflow_dispatch + cron), jamais depuis
// le navigateur d'un client. Utilise un compte admin dédié aux tests
// (TEST_BOT_EMAIL / TEST_BOT_PASSWORD, fournis en secrets GitHub).
//
// Chaque étape s'ajoute à `results` avec {name, status, detail}.
// status: 'PASS' | 'FAIL' | 'SKIP'. Le script quitte avec le code 1
// si au moins un test a échoué, pour que GitHub Actions marque le
// run en rouge.

const SUPABASE_URL = "https://kdmwfbcziokygfcmjxeq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR";

const TEST_BOT_EMAIL = process.env.TEST_BOT_EMAIL;
const TEST_BOT_PASSWORD = process.env.TEST_BOT_PASSWORD;

const TEST_OWNER_EMAIL = "e2e-owner@portail-diagnostic.internal";
const TEST_BUILDING_ADDRESS = "999 Rue Diagnostic (test automatisé)";
const today = new Date().toISOString().slice(0, 10);
const runStamp = Date.now(); // unique par exécution, pour éviter les collisions si le diagnostic tourne plusieurs fois le même jour
const TEST_UNIT_NUMBER = `E2E-${runStamp}`;
const TEST_TENANT_EMAIL = `e2e-tenant-${runStamp}@portail-diagnostic.internal`;
const TEST_MANDAT_EMAIL = `e2e-mandat-${runStamp}@portail-diagnostic.internal`;

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "✅" : status === "SKIP" ? "⏭️ " : "❌";
  console.log(`${icon} ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`login failed (${res.status}): ${JSON.stringify(data)}`);
  return data.access_token;
}

async function callFn(name, jwt, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function restRequest(method, path, jwt, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ([]));
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  if (!TEST_BOT_EMAIL || !TEST_BOT_PASSWORD) {
    record("Configuration", "FAIL", "TEST_BOT_EMAIL / TEST_BOT_PASSWORD manquants (secrets GitHub Actions)");
    return finish();
  }

  let adminJwt;
  try {
    adminJwt = await signIn(TEST_BOT_EMAIL, TEST_BOT_PASSWORD);
    record("Authentification admin (test-bot)", "PASS");
  } catch (e) {
    record("Authentification admin (test-bot)", "FAIL", String(e.message || e));
    return finish();
  }

  const dash = await callFn("admin-api", adminJwt, {});
  if (dash.ok && dash.data.totals) {
    record("Accès admin-api (is_admin vérifié)", "PASS", `${dash.data.totals.clients_count} client(s), ${dash.data.totals.open_anomalies} anomalie(s) ouverte(s)`);
  } else {
    record("Accès admin-api (is_admin vérifié)", "FAIL", `status ${dash.status} — ${JSON.stringify(dash.data)}`);
    return finish();
  }

  // --- Onboarding : propriétaire (réutilisé s'il existe déjà) ---
  let ownerId;
  const foundOwner = await callFn("onboarding-api", adminJwt, { action: "find_owner_by_email", email: TEST_OWNER_EMAIL });
  if (foundOwner.ok && foundOwner.data.owner) {
    ownerId = foundOwner.data.owner.id;
    record("Onboarding — propriétaire de test", "PASS", "existant, réutilisé");
  } else {
    const created = await callFn("onboarding-api", adminJwt, {
      action: "create_owner", full_name: "Propriétaire Diagnostic E2E", email: TEST_OWNER_EMAIL,
      management_rate: 6, spending_cap: 300,
    });
    if (created.ok && created.data.owner_id) {
      ownerId = created.data.owner_id;
      record("Onboarding — propriétaire de test", "PASS", "créé");
    } else {
      record("Onboarding — propriétaire de test", "FAIL", `status ${created.status} — ${JSON.stringify(created.data)}`);
      return finish();
    }
  }

  // --- Onboarding : immeuble (réutilisé s'il existe déjà) ---
  let buildingId;
  const buildings = await callFn("onboarding-api", adminJwt, { action: "list_buildings", owner_id: ownerId });
  const existingBuilding = (buildings.data?.buildings || []).find((b) => b.address === TEST_BUILDING_ADDRESS);
  if (existingBuilding) {
    buildingId = existingBuilding.id;
    record("Onboarding — immeuble de test", "PASS", "existant, réutilisé");
  } else {
    const created = await callFn("onboarding-api", adminJwt, { action: "add_building", owner_id: ownerId, address: TEST_BUILDING_ADDRESS, unit_count: 1 });
    if (created.ok && created.data.building_id) {
      buildingId = created.data.building_id;
      record("Onboarding — immeuble de test", "PASS", "créé");
    } else {
      record("Onboarding — immeuble de test", "FAIL", `status ${created.status} — ${JSON.stringify(created.data)}`);
      return finish();
    }
  }

  // --- Onboarding : unité du jour ---
  let unitId;
  const created_unit = await callFn("onboarding-api", adminJwt, { action: "add_unit", building_id: buildingId, unit_number: TEST_UNIT_NUMBER, unit_type: "3½", rent: 900, status: "occupied" });
  if (created_unit.ok && created_unit.data.unit_id) {
    unitId = created_unit.data.unit_id;
    record("Onboarding — unité du jour", "PASS");
  } else {
    record("Onboarding — unité du jour", "FAIL", `status ${created_unit.status} — ${JSON.stringify(created_unit.data)}`);
    return finish();
  }

  // --- Onboarding : locataire + bail + accès portail ---
  let tenantId, tenantPassword;
  const createdTenant = await callFn("onboarding-api", adminJwt, {
    action: "create_tenant", full_name: "Locataire Diagnostic E2E", email: TEST_TENANT_EMAIL,
    unit_id: unitId, monthly_rent: 900, start_date: today,
  });
  if (createdTenant.ok && createdTenant.data.tenant_id) {
    tenantId = createdTenant.data.tenant_id;
    tenantPassword = createdTenant.data.temp_password;
    record("Onboarding — locataire + bail + accès portail", "PASS");
  } else {
    record("Onboarding — locataire + bail + accès portail", "FAIL", `status ${createdTenant.status} — ${JSON.stringify(createdTenant.data)}`);
    return finish();
  }

  // --- Connexion locataire avec le mot de passe temporaire ---
  let tenantJwt;
  try {
    tenantJwt = await signIn(TEST_TENANT_EMAIL, tenantPassword);
    record("Connexion locataire (mot de passe temporaire)", "PASS");
  } catch (e) {
    record("Connexion locataire (mot de passe temporaire)", "FAIL", String(e.message || e));
    return finish();
  }

  // --- Demande de service par le locataire ---
  const srDescription = `[E2E ${today}] Le chauffe-eau fait un bruit anormal depuis ce matin.`;
  const srInsert = await restRequest("POST", "service_requests", tenantJwt, { unit_id: unitId, tenant_id: tenantId, description: srDescription });
  let serviceRequestId;
  if (srInsert.ok && srInsert.data[0]) {
    serviceRequestId = srInsert.data[0].id;
    record("Locataire — soumission d'une demande de service", "PASS");
  } else {
    record("Locataire — soumission d'une demande de service", "FAIL", `status ${srInsert.status} — ${JSON.stringify(srInsert.data)}`);
    return finish();
  }

  // --- Catégorisation IA (asynchrone, on laisse le temps au trigger) ---
  await sleep(20000);
  const srCheck = await restRequest("GET", `service_requests?id=eq.${serviceRequestId}&select=ai_category,ai_urgency,ai_estimated_cost`, adminJwt);
  const sr = srCheck.data?.[0];
  if (sr && sr.ai_category) {
    record("IA — catégorisation automatique de la demande", "PASS", `${sr.ai_category} / ${sr.ai_urgency} / ${sr.ai_estimated_cost ?? "—"}$`);
  } else {
    // Appel direct de la fonction (contournant le déclencheur pg_net) pour lire
    // sa réponse détaillée et voir précisément où ça échoue.
    const directCall = await callFn("handle-service-request", null, {
      type: "INSERT", table: "service_requests",
      record: { id: serviceRequestId, description: srDescription },
    });
    record("IA — catégorisation automatique de la demande", "FAIL", `ai_category vide après 20s. Appel direct de la fonction -> status ${directCall.status}, réponse: ${JSON.stringify(directCall.data)}`);
  }

  // --- Travail : assignation + complétion (si un travailleur existe) ---
  const workersRes = await callFn("ops-api", adminJwt, { action: "list_workers" });
  const worker = workersRes.data?.workers?.[0];
  if (!worker) {
    record("Travaux — assignation à un travailleur", "SKIP", "aucun travailleur dans le répertoire (table workers) — ajoute-en un pour tester ce chemin");
    record("Travaux — complétion + dépense", "SKIP", "dépend du test précédent");
  } else {
    // Depuis la tâche #39, l'assignation est bloquée si le travailleur
    // n'est pas en conformité (RBQ/assurance) — on met le travailleur de
    // test en conformité avant de tenter l'assignation, sinon ce test
    // échouerait systématiquement sans que ce soit un vrai bug.
    if (worker.missing_rbq_license || worker.rbq_expired || worker.missing_insurance_doc || worker.insurance_expired) {
      const verifyFix = await callFn("ops-api", adminJwt, {
        action: "update_worker_verification", worker_id: worker.id,
        requires_rbq: false,
        insurance_expiry: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        insurance_base64: Buffer.from("preuve d'assurance factice — travailleur de diagnostic E2E").toString("base64"),
        insurance_filename: "assurance-diagnostic.txt",
        insurance_content_type: "text/plain",
        mark_verified: true,
      });
      record("Travailleurs — mise en conformité du travailleur de test", verifyFix.ok ? "PASS" : "FAIL", verifyFix.ok ? "" : JSON.stringify(verifyFix.data));
    } else {
      record("Travailleurs — mise en conformité du travailleur de test", "PASS", "déjà conforme");
    }

    const woCreate = await callFn("ops-api", adminJwt, {
      action: "create_work_order", service_request_id: serviceRequestId, unit_id: unitId,
      worker_id: worker.id, description: srDescription, worker_pay: 50,
    });
    if (woCreate.ok) {
      record("Travaux — assignation à un travailleur", "PASS", `${worker.name}`);
      const woList = await callFn("ops-api", adminJwt, { action: "list_work_orders" });
      const wo = (woList.data?.work_orders || []).find((w) => w.service_request_id === serviceRequestId);
      if (wo) {
        const complete = await callFn("ops-api", adminJwt, { action: "complete_work_order", work_order_id: wo.id, actual_cost: 55 });
        record("Travaux — complétion + dépense", complete.ok ? "PASS" : "FAIL", complete.ok ? "" : JSON.stringify(complete.data));
      } else {
        record("Travaux — complétion + dépense", "FAIL", "work order introuvable après création");
      }
    } else {
      record("Travaux — assignation à un travailleur", "FAIL", JSON.stringify(woCreate.data));
      record("Travaux — complétion + dépense", "SKIP", "dépend du test précédent");
    }
  }

  // --- Formulaire public (anti-spam) + CRM ---
  const publicInquiry = await callFn("handle-public-inquiry", null, {
    type: "mandat", full_name: "Prospect Diagnostic E2E", email: TEST_MANDAT_EMAIL,
    sector: "Secteur test", num_doors: 4, avg_rent: 1000, ownership: "personnel",
    consent: true, website: "",
  });
  if (publicInquiry.ok) {
    record("Site public — soumission formulaire mandat (anti-spam)", "PASS");
  } else {
    record("Site public — soumission formulaire mandat (anti-spam)", "FAIL", `status ${publicInquiry.status} — ${JSON.stringify(publicInquiry.data)}`);
  }

  if (publicInquiry.ok) {
    await sleep(6000);
    const prospects = await callFn("crm-api", adminJwt, { action: "list" });
    const prospect = (prospects.data?.prospects || []).find((p) => p.email === TEST_MANDAT_EMAIL);
    if (prospect && prospect.num_doors === 4) {
      record("CRM — création automatique du prospect", "PASS", `revenu potentiel : ${prospect.potential_monthly_revenue ?? "—"}$`);
    } else if (prospect) {
      record("CRM — création automatique du prospect", "FAIL", "prospect créé mais num_doors/avg_rent absents — vérifier handle-mandat-inquiry");
    } else {
      record("CRM — création automatique du prospect", "FAIL", "aucun prospect trouvé pour ce courriel après 6s");
    }
  }

  return finish();
}

function finish() {
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log("\n--- Résumé ---");
  console.log(`${results.length - failed.length - skipped.length} réussi(s), ${failed.length} échoué(s), ${skipped.length} ignoré(s)`);
  if (failed.length) {
    console.log("\nÉchecs :");
    failed.forEach((f) => console.log(`- ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Erreur inattendue du script de diagnostic :", e);
  process.exitCode = 1;
});
