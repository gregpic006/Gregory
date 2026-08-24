/** Formatage francais, partage par toutes les vues. */

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = [
  "janvier", "fevrier", "mars", "avril", "mai", "juin",
  "juillet", "aout", "septembre", "octobre", "novembre", "decembre",
];

export function greeting(hour: number, name: string): string {
  const who = name ? `, ${name}` : "";
  if (hour < 5) return `Bonne nuit${who}.`;
  if (hour < 12) return `Bon matin${who}.`;
  if (hour < 18) return `Bon apres-midi${who}.`;
  return `Bonsoir${who}.`;
}

export function longDate(date: Date): string {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function clockTime(date: Date): string {
  return `${date.getHours()} h ${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Heure d'un evenement: « 8 h 30 », ou « journee » si sans heure. */
export function eventTime(iso: string, allDay: boolean): string {
  if (allDay) return "journee";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getHours()} h ${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Ecart lisible: « il y a 3 h », « hier ». */
export function relative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "a l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "hier" : `il y a ${days} jours`;
}

/** Nom lisible d'un expediteur: « Marc Tremblay <m@x.com> » -> « Marc Tremblay ». */
export function senderName(raw: string): string {
  const match = /^\s*"?([^"<]+?)"?\s*</.exec(raw);
  return (match ? match[1] : raw.split("@")[0]).trim() || raw;
}
