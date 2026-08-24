/**
 * Verification visuelle: pilote l'interface et capture chaque vue.
 *
 * Sert a regarder ce qu'on livre plutot qu'a le supposer. Necessite une API
 * JARVIS deja lancee.
 *
 *   node scripts/screenshot.mjs [url] [dossier de sortie]
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://127.0.0.1:8787/";
const OUT = process.argv[3] ?? "./screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 980 },
  deviceScaleFactor: 2,
});

const problems = [];
page.on("console", (message) => {
  if (message.type() === "error") problems.push(message.text());
});
page.on("pageerror", (error) => problems.push(String(error)));

await page.goto(URL, { waitUntil: "networkidle" });
// Laisser le noyau s'animer: une capture immediate ne montre rien.
await page.waitForTimeout(2600);
await page.screenshot({ path: `${OUT}/01-accueil.png` });

const views = [
  ["Tableau de bord", "02-tableau-de-bord"],
  ["Conversation", "03-conversation"],
  ["Entreprises", "04-entreprises"],
  ["Memoire", "05-memoire"],
  ["Integrations", "06-integrations"],
  ["Reglages", "07-reglages"],
];
for (const [label, file] of views) {
  await page.click(`.nav-item:has-text("${label}")`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${file}.png` });
}

await page.keyboard.press("Control+k");
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/08-recherche.png` });
await page.keyboard.press("Escape");

await page.click('.nav-item:has-text("Accueil")');
await page.waitForTimeout(300);
await page.click('[title="Mode centre de commande"]');
await page.waitForTimeout(1400);
await page.screenshot({ path: `${OUT}/09-centre-de-commande.png` });

await page.setViewportSize({ width: 1180, height: 820 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/10-portable.png` });

console.log(
  problems.length
    ? `Erreurs console:\n  ${problems.join("\n  ")}`
    : "Aucune erreur console.",
);
console.log(`Captures dans ${OUT}`);
await browser.close();
