import { useEffect, useMemo, useRef, useState } from "react";

import type { Overview, ViewId } from "../lib/types";
import { senderName } from "../lib/format";

interface Entry {
  id: string;
  label: string;
  kind: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  overview: Overview | null;
  onNavigate: (view: ViewId) => void;
  onAsk: (question: string) => void;
}

const PAGES: { view: ViewId; label: string }[] = [
  { view: "home", label: "Accueil" },
  { view: "dashboard", label: "Tableau de bord" },
  { view: "conversation", label: "Conversation" },
  { view: "calendar", label: "Calendrier" },
  { view: "email", label: "Courriels" },
  { view: "tasks", label: "Rappels" },
  { view: "documents", label: "Documents" },
  { view: "businesses", label: "Entreprises" },
  { view: "memory", label: "Memoire" },
  { view: "integrations", label: "Integrations" },
  { view: "settings", label: "Reglages" },
];

/** Recherche globale (Ctrl+K).
 *
 * Elle cherche dans ce qui est deja charge — pages, rendez-vous du jour,
 * courriels non lus, rappels — et propose toujours, en dernier recours, de
 * poser la question a JARVIS. C'est la reponse au « je ne veux pas choisir la
 * source moi-meme »: si la reponse n'est pas sous la main, il va la chercher.
 */
export function CommandPalette({ open, onClose, overview, onNavigate, onAsk }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const needle = query.trim().toLowerCase();
    const all: Entry[] = [];

    for (const page of PAGES) {
      all.push({
        id: `page-${page.view}`,
        label: page.label,
        kind: "page",
        run: () => onNavigate(page.view),
      });
    }

    for (const event of overview?.panes.today.events ?? []) {
      all.push({
        id: `event-${event.id}`,
        label: event.title || "(sans titre)",
        kind: "agenda",
        run: () => onNavigate("calendar"),
      });
    }
    for (const message of overview?.panes.email.messages ?? []) {
      all.push({
        id: `mail-${message.id}`,
        label: `${message.subject || "(sans objet)"} — ${senderName(message.from)}`,
        kind: "courriel",
        run: () => onNavigate("email"),
      });
    }
    for (const reminder of overview?.panes.tasks.reminders ?? []) {
      all.push({
        id: `task-${reminder.id}`,
        label: reminder.text,
        kind: "rappel",
        run: () => onNavigate("tasks"),
      });
    }

    const matched = needle
      ? all.filter((entry) => entry.label.toLowerCase().includes(needle))
      : all.slice(0, 10);

    if (needle) {
      matched.push({
        id: "ask",
        label: `Demander a JARVIS : « ${query.trim()} »`,
        kind: "recherche",
        run: () => onAsk(query.trim()),
      });
    }
    return matched.slice(0, 40);
  }, [query, overview, onNavigate, onAsk]);

  if (!open) return null;

  const choose = (entry: Entry) => {
    entry.run();
    onClose();
  };

  return (
    <div className="palette-backdrop" onClick={onClose} role="presentation">
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Chercher partout, ou demander a JARVIS…"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((c) => Math.min(c + 1, entries.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (event.key === "Enter" && entries[cursor]) {
              event.preventDefault();
              choose(entries[cursor]);
            }
          }}
        />
        <div className="palette-results">
          {entries.length === 0 ? (
            <div className="palette-empty">Rien ne correspond.</div>
          ) : (
            entries.map((entry, index) => (
              <button
                className="palette-item"
                data-active={index === cursor}
                key={entry.id}
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(entry)}
              >
                <span>{entry.label}</span>
                <span className="palette-kind">{entry.kind}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
