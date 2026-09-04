// Le calcul d'heures ouvrables doit rester juste quel que soit le fuseau
// du serveur — c'est exactement ce que l'ancienne version ne garantissait pas.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const local = (ms: number) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
};
const WEEKDAYS = ["Mon","Tue","Wed","Thu","Fri"];
const ok = (iso: string, dur: number) => {
  const { weekday, minutes } = local(Date.parse(iso));
  return WEEKDAYS.includes(weekday) && minutes >= 540 && minutes + dur <= 1020;
};
const cases: [string, number, boolean, string][] = [
  ["2026-09-08T13:00:00Z", 30, true,  "mardi 9 h à Montréal (EDT) — ouvrable"],
  ["2026-09-08T12:30:00Z", 30, false, "mardi 8 h 30 — trop tôt"],
  ["2026-09-08T20:30:00Z", 60, false, "mardi 16 h 30 + 1 h = déborde 17 h"],
  ["2026-09-08T20:00:00Z", 60, true,  "mardi 16 h → 17 h pile — accepté"],
  ["2026-09-06T15:00:00Z", 30, false, "dimanche — refusé"],
  ["2026-09-12T15:00:00Z", 30, false, "samedi — refusé"],
  ["2026-12-08T14:00:00Z", 30, true,  "décembre 9 h (EST, -5) — le décalage saisonnier suit"],
  ["2026-12-08T13:30:00Z", 30, false, "décembre 8 h 30 (EST) — trop tôt"],
];
let f = 0;
for (const [iso, dur, want, label] of cases) {
  const got = ok(iso, dur);
  console.log(`  ${got === want ? "✅" : "❌"} ${label}`);
  if (got !== want) f++;
}
console.log(f ? `❌ ${f} échec(s)` : "✅ tous corrects");
Deno.exit(f ? 1 : 0);
