import { useEffect, useRef } from "react";

import type { AssistantState } from "../../lib/types";

interface Props {
  state: AssistantState;
  /** Niveau du micro (0..1), lu a chaque image quand JARVIS ecoute. */
  levelRef: { current: number };
  size?: number;
}

/** Profil d'animation par etat.
 *
 * Chaque etat a une signature reconnaissable sans lire le texte: on doit
 * savoir d'un coup d'oeil si JARVIS ecoute, cherche ou repond.
 */
interface Profile {
  spin: number;      // vitesse de rotation des anneaux
  energy: number;    // agitation du champ de particules
  glow: number;      // intensite du coeur
  breathe: number;   // amplitude de la respiration
  sweep: number;     // arc de balayage (recherche en cours)
  reactive: number;  // part du niveau audio dans le rendu
}

const PROFILES: Record<AssistantState, Profile> = {
  // Veille: presque immobile, mais jamais mort.
  idle:          { spin: 0.10, energy: 0.20, glow: 0.74, breathe: 0.028, sweep: 0, reactive: 0 },
  // Ecoute: le noyau suit la voix.
  listening:     { spin: 0.18, energy: 0.58, glow: 1.0,  breathe: 0.050, sweep: 0, reactive: 1 },
  transcribing:  { spin: 0.45, energy: 0.64, glow: 0.88, breathe: 0.036, sweep: 0.55, reactive: 0 },
  // Reflexion et outils: rotation franche, arc de balayage.
  understanding: { spin: 0.62, energy: 0.74, glow: 0.90, breathe: 0.028, sweep: 0.85, reactive: 0 },
  working:       { spin: 0.85, energy: 0.95, glow: 0.94, breathe: 0.024, sweep: 1.0,  reactive: 0 },
  // Reponse: pulsation ample, comme une onde vocale circulaire.
  speaking:      { spin: 0.24, energy: 0.70, glow: 1.12, breathe: 0.082, sweep: 0, reactive: 0 },
};

interface Particle {
  angle: number;
  radius: number;   // 0..1, part du rayon interieur
  speed: number;
  phase: number;
  size: number;
}

const PARTICLE_COUNT = 190;
const TICKS = 72;
/** Duree de la sequence d'allumage, en secondes. */
const BOOT_SECONDS = 1.15;
/** Barres du spectre audio autour du noyau. */
const SPECTRUM_BARS = 64;

/** Arcs brisés: rayon, part du cercle couverte, vitesse et sens de rotation.
 *
 * C'est ce qui donne l'impression d'un instrument plutot que d'un logo: des
 * elements independants qui tournent a des vitesses differentes, comme les
 * bagues d'un gyroscope.
 */
const ARCS: { radius: number; span: number; speed: number; width: number; alpha: number }[] = [
  { radius: 1.06, span: 0.22, speed: -0.35, width: 2.2, alpha: 0.55 },
  { radius: 1.06, span: 0.12, speed: -0.35, width: 2.2, alpha: 0.35 },
  { radius: 1.14, span: 0.42, speed: 0.22, width: 1.2, alpha: 0.3 },
  { radius: 1.14, span: 0.09, speed: 0.22, width: 1.2, alpha: 0.5 },
  { radius: 0.6, span: 0.3, speed: 0.55, width: 1.6, alpha: 0.4 },
];

function makeParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    angle: Math.random() * Math.PI * 2,
    // Racine carree: repartition uniforme en surface plutot qu'amassee au centre.
    radius: Math.sqrt(Math.random()) * 0.94,
    speed: (Math.random() * 0.5 + 0.35) * (Math.random() < 0.5 ? -1 : 1),
    phase: Math.random() * Math.PI * 2,
    size: Math.random() * 1.5 + 0.5,
  }));
}

/** Le noyau de JARVIS.
 *
 * Une seule surface canvas, redessinee a chaque image. Trois raisons de ne pas
 * l'avoir fait en DOM ou en SVG: le champ de particules exige des centaines de
 * dessins par image, la lueur radiale se rend nativement en canvas, et le tout
 * reste a 60 images/seconde sur une machine modeste.
 *
 * Les transitions d'etat sont lissees: les parametres glissent vers leur cible
 * au lieu de sauter. C'est ce qui donne l'impression d'un systeme vivant plutot
 * que d'une suite d'animations declenchees.
 */
export function JarvisCore({ state, levelRef, size = 340 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const particles = makeParticles();
    const center = size / 2;
    // 0.32 et non 0.42: la couronne du spectre monte jusqu'a 1.4 fois le rayon,
    // et l'ellipse etire encore de 12 % en hauteur. Au-dela, elle serait rognee.
    const outer = size * 0.32;

    // Parametres lisses: ils poursuivent le profil de l'etat courant.
    const current: Profile = { ...PROFILES.idle };
    let rotation = 0;
    let sweepAngle = 0;
    let smoothLevel = 0;
    let boot = 0;
    let raf = 0;
    let last = performance.now();

    const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;

      const target = PROFILES[stateRef.current] ?? PROFILES.idle;
      // 3.2 = environ 300 ms pour rejoindre la cible: perceptible, jamais brusque.
      const k = 1 - Math.exp(-dt * 3.2);
      current.spin = lerp(current.spin, target.spin, k);
      current.energy = lerp(current.energy, target.energy, k);
      current.glow = lerp(current.glow, target.glow, k);
      current.breathe = lerp(current.breathe, target.breathe, k);
      current.sweep = lerp(current.sweep, target.sweep, k);
      current.reactive = lerp(current.reactive, target.reactive, k);

      // Niveau audio reel quand on ecoute; enveloppe synthetique quand on parle.
      const raw =
        stateRef.current === "speaking"
          ? 0.45 + 0.55 * Math.abs(Math.sin(t * 5.1) * 0.6 + Math.sin(t * 8.7) * 0.4)
          : levelRef.current;
      smoothLevel = lerp(smoothLevel, raw, 1 - Math.exp(-dt * 12));
      const level = smoothLevel * current.reactive + (stateRef.current === "speaking" ? smoothLevel : 0);

      rotation += dt * current.spin * (reduced ? 0.25 : 1);
      sweepAngle += dt * 2.4;

      const breath = Math.sin(t * 1.35) * current.breathe;
      const scale = 1 + breath + level * 0.09;

      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(center, center);
      ctx.scale(scale, scale);

      const intensity = Math.min(1, current.glow + level * 0.45);

      // La sequence d'allumage se joue une seule fois, au montage: les anneaux
      // se referment vers le centre au lieu d'apparaitre d'un coup.
      boot = Math.min(1, boot + dt / BOOT_SECONDS);
      const eased = 1 - Math.pow(1 - boot, 3);

      drawHalo(ctx, outer, intensity * eased);
      drawParticles(ctx, particles, outer * 0.78, t, dt, current.energy, intensity * eased, level);
      drawCore(ctx, outer * 0.17, intensity * eased, level);
      drawArcs(ctx, outer, rotation, intensity * eased, eased);
      drawRings(ctx, outer, rotation, intensity * eased, level);
      drawSpectrum(ctx, outer, t, level, current.energy, intensity * eased);
      if (current.sweep > 0.02) drawSweep(ctx, outer, sweepAngle, current.sweep * intensity);
      if (boot < 1) drawBootRing(ctx, outer, boot);

      ctx.restore();
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className="core-canvas"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** Arcs brisés en rotation libre autour du noyau.
 *
 * Chaque arc tourne a sa propre vitesse, dans son propre sens. L'oeil ne peut
 * pas les suivre tous a la fois: c'est ce qui fait « machine en marche »
 * plutot qu'« image animee ».
 */
function drawArcs(
  ctx: CanvasRenderingContext2D,
  outer: number,
  rotation: number,
  intensity: number,
  boot: number,
): void {
  ctx.save();
  ctx.lineCap = "round";
  for (const [index, arc] of ARCS.entries()) {
    const start = rotation * arc.speed * 6 + index * 1.7;
    const r = outer * arc.radius * (0.86 + boot * 0.14);
    ctx.strokeStyle = `rgba(125, 211, 252, ${arc.alpha * intensity})`;
    ctx.lineWidth = arc.width;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 1.12, 0, start, start + arc.span * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Couronne de barres reagissant a la voix.
 *
 * Au repos elle ondule a peine; en ecoute elle suit le micro reel. C'est le
 * signal le plus direct que JARVIS entend quelque chose.
 */
function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  outer: number,
  t: number,
  level: number,
  energy: number,
  intensity: number,
): void {
  if (intensity <= 0.02) return;
  const base = outer * 1.2;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < SPECTRUM_BARS; i += 1) {
    const angle = (i / SPECTRUM_BARS) * Math.PI * 2;
    // Deux sinusoides de periodes differentes: le motif ne se repete pas
    // visiblement d'un tour a l'autre.
    const wave = Math.sin(t * 2.1 + i * 0.55) * 0.5 + Math.sin(t * 3.7 + i * 0.21) * 0.5;
    const amplitude = 0.02 + energy * 0.015 + level * 0.16 * (0.55 + wave * 0.45);
    const length = outer * amplitude;
    const alpha = (0.14 + level * 0.5 + Math.abs(wave) * 0.12) * intensity;
    ctx.strokeStyle = `rgba(150, 220, 255, ${alpha})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * base, Math.sin(angle) * base * 1.12);
    ctx.lineTo(
      Math.cos(angle) * (base + length),
      Math.sin(angle) * (base + length) * 1.12,
    );
    ctx.stroke();
  }
  ctx.restore();
}

/** Onde d'allumage: un anneau qui se resserre vers le noyau au demarrage. */
function drawBootRing(ctx: CanvasRenderingContext2D, outer: number, boot: number): void {
  const r = outer * (2.1 - boot * 1.05);
  ctx.save();
  ctx.strokeStyle = `rgba(186, 240, 255, ${(1 - boot) * 0.55})`;
  ctx.lineWidth = 2 - boot;
  ctx.beginPath();
  ctx.ellipse(0, 0, r, r * 1.12, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Halo exterieur: la presence de JARVIS dans la piece. */
function drawHalo(ctx: CanvasRenderingContext2D, outer: number, intensity: number): void {
  const halo = ctx.createRadialGradient(0, 0, outer * 0.1, 0, 0, outer * 1.55);
  halo.addColorStop(0, `rgba(56, 189, 248, ${0.26 * intensity})`);
  halo.addColorStop(0.45, `rgba(30, 120, 190, ${0.12 * intensity})`);
  halo.addColorStop(1, "rgba(8, 30, 60, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, outer * 1.55, 0, Math.PI * 2);
  ctx.fill();
}

/** Champ de particules: la densite du noyau, sa matiere. */
function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  radius: number,
  t: number,
  dt: number,
  energy: number,
  intensity: number,
  level: number,
): void {
  for (const particle of particles) {
    particle.angle += dt * particle.speed * energy * 0.65;
    // Respiration propre a chaque particule: le champ ondule au lieu de tourner en bloc.
    const wobble = Math.sin(t * 1.7 + particle.phase) * 0.045 * energy;
    const r = radius * (particle.radius + wobble) * (1 + level * 0.12);
    const x = Math.cos(particle.angle) * r;
    // Le noyau du film est un ovale: on comprime legerement l'axe horizontal.
    const y = Math.sin(particle.angle) * r * 1.12;

    // Les particules du centre brillent davantage: la lumiere vient de la.
    const falloff = 1 - particle.radius * 0.72;
    const alpha = (0.2 + falloff * 0.75) * intensity;
    ctx.fillStyle = `rgba(${140 + falloff * 100}, ${216 + falloff * 30}, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, particle.size * (0.7 + falloff * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Coeur incandescent. */
function drawCore(
  ctx: CanvasRenderingContext2D,
  radius: number,
  intensity: number,
  level: number,
): void {
  const r = radius * (1 + level * 0.3);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.6);
  core.addColorStop(0, `rgba(255, 255, 255, ${0.95 * intensity})`);
  core.addColorStop(0.16, `rgba(186, 240, 255, ${0.8 * intensity})`);
  core.addColorStop(0.42, `rgba(56, 189, 248, ${0.35 * intensity})`);
  core.addColorStop(1, "rgba(12, 123, 168, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.6, 0, Math.PI * 2);
  ctx.fill();
}

/** Anneaux et graduations: la partie « instrument » du noyau. */
function drawRings(
  ctx: CanvasRenderingContext2D,
  outer: number,
  rotation: number,
  intensity: number,
  level: number,
): void {
  const ellipse = (r: number, alpha: number, width: number, dash?: number[]) => {
    ctx.save();
    ctx.strokeStyle = `rgba(125, 211, 252, ${alpha * intensity})`;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 1.12, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  // Anneau interieur, contre-rotation.
  ctx.save();
  ctx.rotate(-rotation * 1.6);
  ellipse(outer * 0.7, 0.3, 1, [2, 9]);
  ctx.restore();

  // Anneau principal.
  ellipse(outer * 0.88, 0.5, 1.2);
  // Enceinte exterieure: elle referme le champ de particules.
  ellipse(outer * 0.97, 0.22, 1, [1, 5]);

  // Couronne graduee, en rotation.
  ctx.save();
  ctx.rotate(rotation);
  for (let i = 0; i < TICKS; i += 1) {
    const angle = (i / TICKS) * Math.PI * 2;
    const major = i % 6 === 0;
    const inner = outer * (major ? 0.93 : 0.955);
    const length = outer * (major ? 1.02 : 0.985);
    ctx.strokeStyle = `rgba(125, 211, 252, ${(major ? 0.72 : 0.34) * intensity})`;
    ctx.lineWidth = major ? 1.4 : 0.8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner * 1.12);
    ctx.lineTo(Math.cos(angle) * length, Math.sin(angle) * length * 1.12);
    ctx.stroke();
  }
  ctx.restore();

  // Marqueurs cardinaux, fixes: ils donnent une orientation stable a l'oeil.
  ctx.save();
  ctx.fillStyle = `rgba(150, 220, 255, ${0.85 * intensity})`;
  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const r = outer * (1.07 + level * 0.05);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r * 1.12;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -4.2);
    ctx.lineTo(3.4, 3);
    ctx.lineTo(-3.4, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Arc de balayage: signale une recherche en cours. */
function drawSweep(
  ctx: CanvasRenderingContext2D,
  outer: number,
  angle: number,
  strength: number,
): void {
  ctx.save();
  ctx.rotate(angle);
  const gradient = ctx.createLinearGradient(0, 0, outer, 0);
  gradient.addColorStop(0, "rgba(125, 211, 252, 0)");
  gradient.addColorStop(1, `rgba(186, 240, 255, ${0.55 * strength})`);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, outer * 0.86, outer * 0.86 * 1.12, 0, -0.42, 0);
  ctx.stroke();
  ctx.restore();
}
