import { useEffect, useState, type ReactNode } from "react";

import { clockTime, longDate } from "../../lib/format";
import type { SystemInfo } from "../../lib/types";
import { IconCollapse, IconExpand, IconSearch } from "./icons";

interface Props {
  system: SystemInfo | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenSearch: () => void;
  voiceLabel: string;
  alertSlot?: ReactNode;
}

/** Barre superieure: la date, l'etat du systeme, l'acces a la recherche. */
export function TopBar({
  system, fullscreen, onToggleFullscreen, onOpenSearch, voiceLabel, alertSlot,
}: Props) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Une fois par seconde: l'horloge d'un centre de commande doit etre juste.
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const google = system?.integrations?.google;

  return (
    <header className="topbar">
      <span className="topbar-clock">
        {longDate(now)} — <b>{clockTime(now)}</b>
      </span>

      <span className="spacer" />

      {system?.dry_run && <span className="chip warn">simulation</span>}
      {system?.providers.llm === "mock" && <span className="chip warn">sans modele</span>}
      {google?.connected && <span className="chip ok">google</span>}
      {system?.providers.stt_available ? (
        <span className="chip accent">voix</span>
      ) : (
        <span className="chip">voix inactive</span>
      )}
      <span className="chip" title="Voix de reponse">{voiceLabel}</span>

      {alertSlot}
      <button className="icon-btn" onClick={onOpenSearch} title="Rechercher (Ctrl+K)">
        <IconSearch />
      </button>
      <button
        className="icon-btn"
        onClick={onToggleFullscreen}
        title={fullscreen ? "Quitter le mode centre de commande" : "Mode centre de commande"}
      >
        {fullscreen ? <IconCollapse /> : <IconExpand />}
      </button>
    </header>
  );
}
