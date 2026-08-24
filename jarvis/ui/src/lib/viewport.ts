/**
 * Taille du noyau JARVIS en fonction de la place reellement disponible.
 *
 * Un noyau de taille fixe passe bien sur un grand ecran et pousse les cartes
 * sous la ligne de flottaison sur un portable: l'accueil doit se lire d'un
 * coup d'oeil, pas se scroller.
 */
import { useEffect, useState } from "react";

// Ces deux constantes sont mesurees sur le rendu reel (scripts/screenshot.mjs),
// pas estimees: une valeur trop basse coupe les cartes sous la ligne de flottaison.

/** Barre du haut (62) + salut (57) + legende (34) + barre de commande (108) + marges. */
const CHROME = 310;
/** Les deux rangees de cartes plus leurs gouttieres, quand elles passent sous le noyau. */
const STACKED_PANES = 285;
/** En dessous, la grille d'accueil s'empile en une seule colonne (cf. global.css). */
const STACK_BREAKPOINT = 1180;

function computeCoreSize(width: number, height: number, fullscreen: boolean): number {
  const stacked = width <= STACK_BREAKPOINT;
  const available = height - CHROME - (stacked ? STACKED_PANES : 0);
  const widthCap = stacked ? width * 0.6 : width * 0.3;
  const maxCap = fullscreen ? 520 : 400;
  return Math.round(Math.max(200, Math.min(available, widthCap, maxCap)));
}

export function useCoreSize(fullscreen: boolean): number {
  const [size, setSize] = useState(() =>
    computeCoreSize(window.innerWidth, window.innerHeight, fullscreen),
  );

  useEffect(() => {
    const update = () =>
      setSize(computeCoreSize(window.innerWidth, window.innerHeight, fullscreen));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [fullscreen]);

  return size;
}
