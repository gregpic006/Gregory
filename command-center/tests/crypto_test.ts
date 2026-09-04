// Vérifie ce qui échouerait silencieusement en production : un jeton
// mal chiffré ne se voit qu'au moment où Google refuse la connexion, et
// un corps de courriel mal décodé produit un tri IA plausible mais faux.
Deno.env.set("CC_TOKEN_KEY", btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
Deno.env.set("SUPABASE_URL", "https://exemple.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");

const { encryptToken, decryptToken, assertCronSecret, truncate } = await import(
  new URL("../supabase/functions/_shared/cc.ts", import.meta.url).href
);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${got !== undefined ? ` — obtenu : ${JSON.stringify(got)}` : ""}`); }
};

console.log("\n— Chiffrement des jetons Google —");
const secret = "1//0gTokenGoogleAvecDesAccentsÉÀÇ-et_des/caractères+spéciaux==";
const enc = await encryptToken(secret);
check("aller-retour identique", await decryptToken(enc) === secret);
check("le chiffré ne contient pas le clair", !enc.includes("TokenGoogle"));
const enc2 = await encryptToken(secret);
check("deux chiffrements du même secret diffèrent (IV aléatoire)", enc !== enc2);
check("les deux se déchiffrent quand même", await decryptToken(enc2) === secret);
try { await decryptToken("nimportequoi.abcd"); check("un chiffré corrompu est rejeté", false); }
catch { check("un chiffré corrompu est rejeté", true); }

console.log("\n— Secret de cron —");
Deno.env.set("CC_CRON_SECRET", "s3cr3t-de-cron-partage");
const withHeader = (v: string) => new Request("https://x", { headers: { "x-cc-cron-secret": v } });
check("bon secret accepté", assertCronSecret(withHeader("s3cr3t-de-cron-partage")));
check("mauvais secret refusé", !assertCronSecret(withHeader("mauvais")));
check("secret vide refusé", !assertCronSecret(new Request("https://x")));
check("préfixe correct refusé", !assertCronSecret(withHeader("s3cr3t")));

console.log("\n— truncate —");
check("court : inchangé", truncate("abc", 10) === "abc");
check("long : coupé avec ellipse", truncate("abcdefghij", 5) === "abcde…");
check("null : chaîne vide", truncate(null, 5) === "");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} réussis, ${fail} échoués`);
if (fail) Deno.exit(1);
