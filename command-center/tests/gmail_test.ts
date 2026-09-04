// On simule une vraie réponse de l'API Gmail plutôt que de tester les
// fonctions internes une par une : c'est le chemin complet (base64url →
// arbre MIME → texte lisible) qui doit marcher.
Deno.env.set("SUPABASE_URL", "https://exemple.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");

const b64url = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let mock: unknown = null;
globalThis.fetch = ((..._a: unknown[]) =>
  Promise.resolve(new Response(JSON.stringify(mock), { status: 200 }))) as typeof fetch;

const { fetchGmailMessage } = await import(
  new URL("../supabase/functions/_shared/google.ts", import.meta.url).href
);

let pass = 0, fail = 0;
const check = (n: string, c: boolean, got?: unknown) => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n} — obtenu : ${JSON.stringify(got)}`); }
};

console.log("\n— Courriel multipart, texte + HTML, avec pièce jointe —");
mock = {
  id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], snippet: "aperçu",
  internalDate: "1788508800000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: '"Picard, Greg" <Greg.Picard@LeaseLane.ca>' },
      { name: "To", value: 'xav@leaselane.ca, "Tremblay, Éliot" <eliot@leaselane.ca>' },
      { name: "Cc", value: "steven@leaselane.ca" },
      { name: "Subject", value: "Bail à réviser — 4520 rue Sainte-Catherine" },
    ],
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64url("Salut,\n\nLe bail est prêt. Loyer : 1 450 $/mois.\n\nGreg") } },
        { mimeType: "text/html", body: { data: b64url("<p>version HTML à ignorer</p>") } },
      ]},
      { mimeType: "application/pdf", filename: "bail.pdf", body: { attachmentId: "att1", size: 90210 } },
    ],
  },
};
let m = await fetchGmailMessage("tok", "m1");
check("nom d'expéditeur entre guillemets", m.from_name === "Picard, Greg", m.from_name);
check("adresse mise en minuscules", m.from_email === "greg.picard@leaselane.ca", m.from_email);
check("destinataires découpés malgré la virgule dans un nom",
  JSON.stringify(m.to_emails) === '["xav@leaselane.ca","eliot@leaselane.ca"]', m.to_emails);
check("copie conforme lue", JSON.stringify(m.cc_emails) === '["steven@leaselane.ca"]', m.cc_emails);
check("sujet avec accents intact", m.subject.includes("réviser"), m.subject);
check("texte brut préféré au HTML", m.body_text.includes("Le bail est prêt") && !m.body_text.includes("HTML à ignorer"), m.body_text);
check("accents et symbole dollar préservés", m.body_text.includes("1 450 $/mois"), m.body_text);
check("pièce jointe détectée", m.has_attachments === true);
check("non lu détecté", m.is_unread === true);
check("date convertie en ISO", (m.received_at ?? "").startsWith("2026-"), m.received_at);

console.log("\n— Courriel HTML seulement (infolettre typique) —");
mock = {
  id: "m2", threadId: "t2", labelIds: ["INBOX"], internalDate: "1788508800000",
  payload: {
    mimeType: "text/html",
    headers: [{ name: "From", value: "no-reply@outil.com" }, { name: "Subject", value: "Infolettre" }],
    body: { data: b64url("<style>p{color:red}</style><h1>Titre</h1><p>Première ligne</p><p>Deuxième&nbsp;ligne</p>") },
  },
};
m = await fetchGmailMessage("tok", "m2");
check("adresse nue reconnue", m.from_email === "no-reply@outil.com", m.from_email);
check("HTML converti en texte", m.body_text.includes("Titre") && m.body_text.includes("Première ligne"), m.body_text);
check("le CSS est retiré", !m.body_text.includes("color:red"), m.body_text);
check("les balises sont retirées", !m.body_text.includes("<p>"), m.body_text);
check("&nbsp; décodé", m.body_text.includes("Deuxième ligne"), m.body_text);
check("aucune pièce jointe", m.has_attachments === false);

console.log("\n— Courriel vide / malformé (ne doit pas planter) —");
mock = { id: "m3", threadId: "t3", internalDate: "1788508800000", payload: { headers: [] } };
m = await fetchGmailMessage("tok", "m3");
check("corps vide toléré", m.body_text === "", m.body_text);
check("expéditeur absent → null", m.from_email === null, m.from_email);
check("sujet absent → chaîne vide", m.subject === "", m.subject);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} réussis, ${fail} échoués`);
if (fail) Deno.exit(1);
