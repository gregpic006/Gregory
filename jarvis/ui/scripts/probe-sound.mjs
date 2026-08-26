/**
 * Mesure les sons de l'interface, au lieu de les croire.
 *
 * Les sons sont synthetises: on peut donc les rendre hors ligne et mesurer
 * leur duree, leur volume de crete et leur hauteur. C'est la seule facon
 * honnete de verifier un son quand on ne peut pas l'ecouter.
 *
 *   npx vite --port 5199 &
 *   node scripts/probe-sound.mjs
 *
 * Regles de conception verifiees ici: rien au-dessus de 400 ms, aucune crete
 * au-dessus de 0.08. Un son d'interface qu'on remarque est un son rate.
 */
import { chromium } from "playwright";

const MAX_MS = 400;
const MAX_PEAK = 0.08;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
  // Sans ce drapeau, `AudioContext.resume()` ne se resout jamais tant qu'aucun
  // geste n'a eu lieu, et la page de mesure reste bloquee. C'est exactement la
  // regle des navigateurs contre laquelle le kit se protege; ici on la leve
  // pour pouvoir mesurer.
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:5199/scripts/probe-sound.html", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__RESULT__ !== undefined, { timeout: 30000 });
const { measured: rows, rules } = await page.evaluate(() => window.__RESULT__);
await browser.close();

if (errors.length) {
  console.error("erreurs de page:", errors);
  process.exit(1);
}

let failed = false;
console.log("son".padEnd(9), "duree".padStart(8), "crete".padStart(8), "hauteur".padStart(9));
for (const row of rows) {
  const bad = row.ms > MAX_MS || row.peak > MAX_PEAK;
  if (bad) failed = true;
  console.log(
    row.cue.padEnd(9),
    `${row.ms} ms`.padStart(8),
    String(row.peak).padStart(8),
    `${row.hz} Hz`.padStart(9),
    bad ? "  <-- hors des bornes" : "",
  );
}
console.log();
for (const [rule, ok] of Object.entries(rules)) {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "RATE"}  ${rule.replace(/_/g, " ")}`);
}

process.exit(failed ? 1 : 0);
