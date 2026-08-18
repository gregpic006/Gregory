// Test de charge — mesure la latence et le taux de succès sous
// concurrence, pour repérer un point de rupture avant qu'il arrive en
// vrai (ex: la vague de rappels de loyer du 1er du mois, ou un pic de
// demandes de service après une tempête).
//
// ⚠️ Cible UNIQUEMENT health-check (public, lecture seule, sans effet
// de bord) — PAS de vrai environnement de préproduction distinct de la
// prod pour l'instant (aucune base de test séparée n'existe). Tant que
// ça reste le cas, ce script ne doit PAS être étendu pour frapper des
// fonctions qui écrivent des données ou envoient des courriels/SMS —
// ça créerait de vraies données factices ou spammerait de vrais
// destinataires. Une fois un projet Supabase de préproduction créé
// (voir README, section CI/CD), ce script pourra être élargi en lui
// passant une URL de base différente en argument.
//
// Exécuté via GitHub Actions (workflow_dispatch uniquement — voir
// load-test.yml), jamais en cron automatique.

const SUPABASE_URL = process.env.LOAD_TEST_BASE_URL || "https://kdmwfbcziokygfcmjxeq.supabase.co";
const TARGET_PATH = "/functions/v1/health-check";
const CONCURRENCY = Number(process.env.LOAD_TEST_CONCURRENCY || 10);
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION_SECONDS || 30);

if (!SUPABASE_URL.includes("kdmwfbcziokygfcmjxeq") && !process.env.LOAD_TEST_BASE_URL) {
  console.error("URL de base inattendue — arrêt par sécurité.");
  process.exit(1);
}

const latencies = [];
let successCount = 0;
let errorCount = 0;
let running = true;

async function worker() {
  while (running) {
    const startedAt = performance.now();
    try {
      const res = await fetch(`${SUPABASE_URL}${TARGET_PATH}`);
      await res.arrayBuffer(); // consomme le corps pour mesurer la latence complète
      latencies.push(performance.now() - startedAt);
      if (res.ok) successCount++;
      else errorCount++;
    } catch {
      latencies.push(performance.now() - startedAt);
      errorCount++;
    }
  }
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

async function main() {
  console.log(`Test de charge — ${CONCURRENCY} requêtes concurrentes pendant ${DURATION_SECONDS}s contre ${TARGET_PATH}`);
  const workers = Array.from({ length: CONCURRENCY }, () => worker());

  await new Promise((resolve) => setTimeout(resolve, DURATION_SECONDS * 1000));
  running = false;
  await Promise.all(workers);

  const total = successCount + errorCount;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  console.log("");
  console.log(`Requêtes totales      : ${total}`);
  console.log(`Succès                : ${successCount} (${((successCount / total) * 100).toFixed(1)}%)`);
  console.log(`Erreurs                : ${errorCount}`);
  console.log(`Débit                  : ${(total / DURATION_SECONDS).toFixed(1)} req/s`);
  console.log(`Latence moyenne        : ${avg.toFixed(0)} ms`);
  console.log(`Latence p50            : ${percentile(sorted, 50).toFixed(0)} ms`);
  console.log(`Latence p95            : ${percentile(sorted, 95).toFixed(0)} ms`);
  console.log(`Latence p99            : ${percentile(sorted, 99).toFixed(0)} ms`);

  if (errorCount / total > 0.05) {
    console.error("\n❌ Taux d'erreur au-dessus de 5% — investigation requise.");
    process.exit(1);
  }
  console.log("\n✅ Taux d'erreur acceptable.");
}

main();
