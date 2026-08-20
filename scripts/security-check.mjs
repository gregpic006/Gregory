// Tests d'étanchéité — vérifie en conditions réelles (contre la prod)
// que les protections déjà en place résistent vraiment à un accès non
// autorisé. Ne fait AUCUNE action destructive ou coûteuse (pas de
// sync_all réel, pas d'écriture) : uniquement des tentatives d'accès
// qui DOIVENT échouer, et vérifie qu'elles échouent bien.
//
// Exécuté via GitHub Actions (workflow_dispatch uniquement — voir
// security-check.yml), sur le même modèle que e2e-diagnostic.mjs :
// déclenché manuellement, jamais en cron automatique non supervisé.
//
// Chaque test s'ajoute à `results` avec {name, status, detail}.
// status: 'PASS' (la protection a bien bloqué l'accès) | 'FAIL' (accès
// obtenu alors qu'il aurait dû être refusé — faille réelle) | 'SKIP'.
// Le script quitte avec le code 1 si au moins un test échoue.

const SUPABASE_URL = "https://kdmwfbcziokygfcmjxeq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_XJTO7hD6WHG9uK7Sg7LNDg_MM46QALR";

const results = [];
function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "✅" : status === "SKIP" ? "⏭️ " : "❌";
  console.log(`${icon} ${name}${detail ? " — " + detail : ""}`);
}

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// JWT dont la signature est fabriquée (pas signée avec le vrai secret du
// projet, qu'un attaquant ne connaît évidemment pas) — c'est exactement
// ce qu'un attaquant sans accès au secret peut produire. Si une fonction
// l'accepte, la vérification de signature ne fonctionne pas.
function forgedJwt(claimsOverride = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: "00000000-0000-0000-0000-000000000000",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claimsOverride,
  };
  return `${base64url(header)}.${base64url(payload)}.forged_signature_not_valid_${Date.now()}`;
}

async function callFn(name, jwtOrNull, body, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      ...(jwtOrNull ? { Authorization: `Bearer ${jwtOrNull}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function restRequestAnon(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  const data = await res.json().catch(() => []);
  return { ok: res.ok, status: res.status, data };
}

// ---- 1. Fonctions admin-authentifiées : un JWT forgé doit être rejeté ----
// C'est le test de régression direct sur le correctif de vérification
// de signature JWT (voir README, section "Sécurité — vérification JWT").
const ADMIN_FUNCTIONS = [
  "ops-api", "worker-api", "caller-api", "onboarding-api",
  "reconcile-bank-transactions", "crm-api", "admin-api", "privacy-api",
  "ask-documents", "ask-finances", "handle-lease-renewal-notice", "flinks-api",
  "parse-expense-receipt",
];

async function testForgedJwtRejected() {
  const jwt = forgedJwt();
  for (const fn of ADMIN_FUNCTIONS) {
    const res = await callFn(fn, jwt, { action: "list" });
    if (res.status === 401) {
      record(`JWT forgé rejeté — ${fn}`, "PASS");
    } else {
      record(`JWT forgé rejeté — ${fn}`, "FAIL", `Statut ${res.status} au lieu de 401 — signature JWT non vérifiée ?`);
    }
  }
}

// ---- 2. Fonctions admin-authentifiées : aucune Authorization → 401 ----
async function testNoAuthRejected() {
  for (const fn of ["ops-api", "admin-api", "onboarding-api"]) {
    const res = await callFn(fn, null, {});
    if (res.status === 401) {
      record(`Requête sans authentification rejetée — ${fn}`, "PASS");
    } else {
      record(`Requête sans authentification rejetée — ${fn}`, "FAIL", `Statut ${res.status} au lieu de 401`);
    }
  }
}

// ---- 3. flinks-api sync_all sans le secret partagé → 403 ----
async function testFlinksSyncAllProtected() {
  const res = await callFn("flinks-api", null, { action: "sync_all" });
  if (res.status === 403) {
    record("flinks-api sync_all sans secret rejeté", "PASS");
  } else {
    record("flinks-api sync_all sans secret rejeté", "FAIL", `Statut ${res.status} au lieu de 403 — une synchronisation bancaire réelle pourrait être déclenchée sans autorisation`);
  }
}

// ---- 4. Aucune des 41 tables ne doit exposer de vraies données à la clé anon seule ----
// Couvre à la fois les tables verrouillées service_role (RLS activée,
// aucune policy) et les tables "propres à un rôle" (owners, units,
// leases, payments, documents...) : dans les deux cas, la clé anon
// seule — sans JWT d'un usager authentifié — ne doit jamais recevoir
// une ligne réelle. Liste extraite de schema.sql (`create table`).
const ALL_TABLES = [
  "ai_run_log", "approvals", "audit_log", "automation_rule_runs", "automation_rules",
  "bank_connections", "bank_transactions", "buildings", "cold_callers", "company_settings",
  "dissatisfaction_signals", "documents", "expenses", "financial_anomalies", "inquiries",
  "invoice_number_counters", "invoices", "job_offers", "lease_signatures", "leases",
  "messages", "owners", "pad_authorizations", "payment_reminders", "payments",
  "personal_data_requests", "privacy_incidents", "prospects", "public_submission_log",
  "reports", "service_catalog", "service_requests", "sms_log", "system_health_alert_state",
  "tenants", "units", "users", "visits", "work_orders", "worker_ratings", "workers",
];

async function testNoRealDataReadableByAnon() {
  for (const table of ALL_TABLES) {
    const res = await restRequestAnon(table);
    const rowCount = Array.isArray(res.data) ? res.data.length : -1;
    if (res.status === 200 && rowCount === 0) {
      record(`Aucune donnée réelle exposée à la clé anon — ${table}`, "PASS");
    } else if (res.status === 401 || res.status === 403) {
      record(`Aucune donnée réelle exposée à la clé anon — ${table}`, "PASS", `Statut ${res.status}`);
    } else if (res.status === 404) {
      // PostgREST renvoie 404 (plutôt que 200+[]) quand le rôle appelant
      // n'a AUCUN privilège sur la table, même pas de quoi confirmer son
      // existence — c'est une protection plus forte qu'un tableau vide,
      // pas une faille.
      record(`Aucune donnée réelle exposée à la clé anon — ${table}`, "PASS", `Statut 404 — table invisible pour la clé anon (aucun privilège)`);
    } else {
      record(`Aucune donnée réelle exposée à la clé anon — ${table}`, "FAIL", `Statut ${res.status}, ${rowCount} ligne(s) retournée(s) — RLS ne bloque pas cette table`);
    }
  }
}

// ---- 5. Endpoint public de santé — juste vérifier qu'il répond ----
async function testHealthCheckReachable() {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/health-check`, { headers: { apikey: SUPABASE_ANON_KEY } });
    if (res.status === 200 || res.status === 503) {
      record("Endpoint health-check joignable", "PASS", `Statut ${res.status}`);
    } else {
      record("Endpoint health-check joignable", "FAIL", `Statut inattendu ${res.status}`);
    }
  } catch (e) {
    record("Endpoint health-check joignable", "FAIL", String(e.message || e));
  }
}

// ---- 6. Stockage (documents, photos) : la clé anon ne doit lister aucun fichier ----
const STORAGE_BUCKETS = ["documents", "service-request-photos"];

async function testStorageBucketsNotListableByAnon() {
  for (const bucket of STORAGE_BUCKETS) {
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "", limit: 10 }),
      });
      const data = await res.json().catch(() => []);
      const count = Array.isArray(data) ? data.length : -1;
      if ((res.status === 200 && count === 0) || [400, 401, 403, 404].includes(res.status)) {
        record(`Aucun fichier listé par la clé anon — ${bucket}`, "PASS", `Statut ${res.status}`);
      } else {
        record(`Aucun fichier listé par la clé anon — ${bucket}`, "FAIL", `Statut ${res.status}, ${count} fichier(s) listé(s) — RLS storage ne bloque pas ce bucket`);
      }
    } catch (e) {
      record(`Aucun fichier listé par la clé anon — ${bucket}`, "FAIL", String(e.message || e));
    }
  }
}

async function main() {
  await testForgedJwtRejected();
  await testNoAuthRejected();
  await testFlinksSyncAllProtected();
  await testNoRealDataReadableByAnon();
  await testStorageBucketsNotListableByAnon();
  await testHealthCheckReachable();

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length} test(s) — ${results.length - failed.length} réussi(s), ${failed.length} échoué(s).`);
  if (failed.length) {
    console.log("\n⚠️  Failles potentielles détectées :");
    failed.forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
    process.exit(1);
  }
}

main();
