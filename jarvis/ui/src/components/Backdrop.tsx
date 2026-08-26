import { useEffect, useRef } from "react";

import type { AssistantState } from "../lib/types";

/**
 * Le fond holographique.
 *
 * Dans l'atelier du film, ce qui frappe n'est pas un ecran: c'est que **tout
 * l'espace** est habite. Une maille bleue tres faible, un balayage lent, une
 * lueur qui s'eteint sur les bords. Un fond noir plat, si sombre soit-il,
 * reste une page web.
 *
 * Cette couche dessine cet espace derriere l'interface. Elle ne represente
 * aucune donnee — et c'est deliberé: un decor qui imiterait des chiffres
 * serait un mensonge visuel, exactement ce que le reste du projet s'interdit.
 * C'est de la lumiere, rien d'autre.
 *
 * Trois contraintes la gouvernent.
 *
 * **Elle ne doit jamais gener la lecture.** Les opacites sont sous 0.1. Si on
 * la remarque en lisant un courriel, elle est ratee.
 *
 * **Elle ne doit rien couter.** Une image par seconde suffirait pour ce
 * mouvement; on tourne a 30 pour rester fluide, et on s'arrete completement
 * quand l'onglet passe en arriere-plan.
 *
 * **Elle respecte « animations reduites ».** Un utilisateur qui a demande
 * moins de mouvement obtient une grille fixe, pas une exception.
 */

interface Props {
  state: AssistantState;
}

/** Maille de la grille, en pixels. */
const CELL = 46;
/** Au-dela, on ne redessine pas: 30 images/s suffisent pour ce mouvement. */
const FRAME_MS = 1000 / 30;

/** Intensite du fond selon ce que fait JARVIS.
 *
 * Le decor suit l'etat, discretement: la piece s'eveille quand il travaille.
 * C'est la seule chose que ce fond « dit », et elle est vraie.
 */
const INTENSITY: Record<AssistantState, number> = {
  idle: 0.55,
  listening: 0.9,
  transcribing: 0.95,
  understanding: 1.0,
  working: 1.2,
  speaking: 0.85,
};

export function Backdrop({ state }: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<AssistantState>(state);
  stateRef.current = state;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let width = 0;
    let height = 0;
    let raf = 0;
    let last = 0;
    let running = true;

    const resize = () => {
      // On plafonne a 1.5: au-dela, on paie des pixels que personne ne voit
      // sur un decor a 6 % d'opacite.
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = element.clientWidth;
      height = element.clientHeight;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (time: number) => {
      const t = reduced ? 0 : time / 1000;
      const gain = INTENSITY[stateRef.current] ?? 0.6;
      context.clearRect(0, 0, width, height);

      // --- maille ----------------------------------------------------------
      // Une grille orthogonale, pas une fuite en perspective: l'interface est
      // un tableau de bord, pas une vue a la premiere personne. Une ligne
      // d'horizon la traverserait comme une rayure.
      //
      // Elle derive tres lentement en diagonale — assez pour que l'image ne
      // soit jamais tout a fait la meme, trop peu pour qu'on suive une ligne
      // des yeux.
      const driftX = (t * 3.5) % CELL;
      const driftY = (t * 2.1) % CELL;
      context.lineWidth = 1;
      context.strokeStyle = `rgba(90, 190, 250, ${0.055 * gain})`;
      context.beginPath();
      for (let x = -CELL + driftX; x < width + CELL; x += CELL) {
        context.moveTo(Math.round(x) + 0.5, 0);
        context.lineTo(Math.round(x) + 0.5, height);
      }
      for (let y = -CELL + driftY; y < height + CELL; y += CELL) {
        context.moveTo(0, Math.round(y) + 0.5);
        context.lineTo(width, Math.round(y) + 0.5);
      }
      context.stroke();

      // Une maille sur quatre est plus marquee: sans cela, la grille est un
      // aplat gris et ne se lit plus comme une structure.
      context.strokeStyle = `rgba(120, 210, 255, ${0.075 * gain})`;
      context.beginPath();
      for (let x = -CELL + driftX, i = 0; x < width + CELL; x += CELL, i++) {
        if (i % 4) continue;
        context.moveTo(Math.round(x) + 0.5, 0);
        context.lineTo(Math.round(x) + 0.5, height);
      }
      for (let y = -CELL + driftY, i = 0; y < height + CELL; y += CELL, i++) {
        if (i % 4) continue;
        context.moveTo(0, Math.round(y) + 0.5);
        context.lineTo(width, Math.round(y) + 0.5);
      }
      context.stroke();

      // --- balayage ---------------------------------------------------------
      // Une bande claire qui descend, comme un scanner. Tres faible: on la
      // percoit du coin de l'oeil, on ne la regarde pas.
      if (!reduced) {
        const sweep = ((t * 0.06) % 1.4 - 0.2) * height;
        const band = context.createLinearGradient(0, sweep - 120, 0, sweep + 120);
        band.addColorStop(0, "rgba(90, 190, 250, 0)");
        band.addColorStop(0.5, `rgba(130, 215, 255, ${0.05 * gain})`);
        band.addColorStop(1, "rgba(90, 190, 250, 0)");
        context.fillStyle = band;
        context.fillRect(0, sweep - 120, width, 240);
      }

      // --- vignette ---------------------------------------------------------
      // La grille s'efface sur les bords. C'est ce qui empeche le fond de
      // ressembler a du papier millimetre: au centre une structure, au bord
      // une lueur.
      const vignette = context.createRadialGradient(
        width / 2, height / 2, Math.min(width, height) * 0.42,
        width / 2, height / 2, Math.max(width, height) * 0.95,
      );
      vignette.addColorStop(0, "rgba(3, 6, 11, 0)");
      vignette.addColorStop(1, "rgba(3, 6, 11, 0.78)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);

      if (!running) return;
      raf = requestAnimationFrame(loop);
    };

    const loop = (time: number) => {
      if (!running) return;
      // Une image fixe suffit quand le mouvement est refuse: on dessine une
      // fois et on rend la main.
      if (reduced) {
        draw(0);
        return;
      }
      if (time - last < FRAME_MS) {
        raf = requestAnimationFrame(loop);
        return;
      }
      last = time;
      draw(time);
    };

    const onVisibility = () => {
      // Un onglet cache ne doit pas consommer: `requestAnimationFrame` ralentit
      // deja, mais l'arret est explicite et verifiable.
      running = document.visibilityState === "visible";
      if (running) {
        last = 0;
        raf = requestAnimationFrame(loop);
      } else {
        cancelAnimationFrame(raf);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvas} className="backdrop" aria-hidden="true" />;
}
