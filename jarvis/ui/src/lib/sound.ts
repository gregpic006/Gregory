/**
 * Le son de l'interface.
 *
 * Dans la scene de l'atelier, ce qui donne l'impression que la machine est
 * vivante n'est pas l'image: c'est le son. Chaque geste repond. Un ecran
 * silencieux, si beau soit-il, reste un site web.
 *
 * Tout est **synthetise ici, a la volee**. Aucun fichier, aucun
 * telechargement, rien qui vienne d'une bande son existante — les sons du film
 * appartiennent a leur studio. Ce sont des sons originaux, ecrits dans le meme
 * esprit: courts, doux, graves, jamais stridents.
 *
 * Quatre regles tiennent ce module.
 *
 * 1. **Discret ou rien.** Un son d'interface qu'on remarque est un son rate.
 *    Les volumes sont bas et les durees sous 400 ms.
 * 2. **Jamais pendant que JARVIS parle.** Un bip par-dessus la voix, c'est la
 *    voix qu'on perd.
 * 3. **Le navigateur decide quand le son peut demarrer.** Aucun contexte audio
 *    n'existe avant un geste de l'utilisateur: c'est la regle des navigateurs,
 *    et la contourner ne marche pas.
 * 4. **Une panne audio n'est jamais une panne d'application.** Tout est sous
 *    `try`. Au pire, l'interface redevient muette.
 */

const STORAGE_KEY = "jarvis.sound";

/** Gestes que les navigateurs acceptent comme autorisation de jouer du son. */
const GESTURES = ["pointerdown", "keydown", "touchstart"] as const;

/** Sons disponibles. */
export type Cue =
  | "tap"
  | "wake"
  | "listen"
  | "send"
  | "reply"
  | "alert"
  | "error";

interface Tone {
  /** Frequence de depart, en Hz. */
  from: number;
  /** Frequence d'arrivee. Egale a `from` pour une note tenue. */
  to: number;
  /** Duree en secondes. */
  duration: number;
  /** Volume de crete, 0..1. */
  gain: number;
  type: OscillatorType;
  /** Retard avant le depart, pour composer un accord ou un arpege. */
  delay?: number;
}

/**
 * Les sons, note par note.
 *
 * Les frequences ne sont pas prises au hasard: les intervalles sont
 * consonants (quinte, octave) pour que deux sons qui se chevauchent ne
 * battent pas. Les timbres sont des sinus et des triangles — une dent de scie
 * sonnerait agressive dans les aigus.
 */
const CUES: Record<Cue, Tone[]> = {
  // Le « tap ». Une pression breve et mate: un corps grave tres court, et
  // juste au-dessus une pointe aigue qui donne le contact.
  tap: [
    { from: 660, to: 520, duration: 0.055, gain: 0.05, type: "sine" },
    { from: 2100, to: 1750, duration: 0.035, gain: 0.022, type: "sine" },
  ],

  // Le reveil. Deux notes qui montent d'une quinte: la machine se met a
  // l'ecoute. C'est le seul son legerement plus long, parce qu'il annonce.
  wake: [
    { from: 520, to: 520, duration: 0.12, gain: 0.05, type: "sine" },
    { from: 784, to: 784, duration: 0.22, gain: 0.045, type: "sine", delay: 0.09 },
    { from: 1568, to: 1568, duration: 0.18, gain: 0.014, type: "sine", delay: 0.09 },
  ],

  // L'ecoute commence. Une note grave et tenue, presque un souffle.
  listen: [{ from: 300, to: 330, duration: 0.18, gain: 0.035, type: "triangle" }],

  // L'envoi. Un balayage vers le haut, court: quelque chose part.
  send: [{ from: 420, to: 900, duration: 0.13, gain: 0.04, type: "triangle" }],

  // La reponse arrive. Le meme balayage a l'envers: quelque chose revient.
  reply: [
    { from: 880, to: 587, duration: 0.14, gain: 0.038, type: "sine" },
    { from: 440, to: 294, duration: 0.16, gain: 0.02, type: "sine" },
  ],

  // Une alerte. Deux notes egales, posees, sans urgence feinte: JARVIS
  // signale, il ne panique pas.
  alert: [
    { from: 740, to: 740, duration: 0.1, gain: 0.05, type: "sine" },
    { from: 740, to: 740, duration: 0.14, gain: 0.05, type: "sine", delay: 0.17 },
  ],

  // Une erreur. Descente d'une tierce mineure: on entend que ca ne va pas,
  // sans que ce soit desagreable.
  error: [
    { from: 420, to: 300, duration: 0.2, gain: 0.05, type: "triangle" },
    { from: 210, to: 150, duration: 0.24, gain: 0.03, type: "sine" },
  ],
};

/** Reglage de volume global, par-dessus les volumes de chaque son. */
const MASTER = 0.9;

type AudioContextCtor = typeof AudioContext;

function getAudioContext(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Ecrit les notes d'un son dans un contexte audio.
 *
 * Extrait de la classe pour une raison precise: rendu dans un
 * `OfflineAudioContext`, il produit exactement le meme signal qu'a l'ecran.
 * C'est ce qui rend ces sons **verifiables** — on peut mesurer leur duree,
 * leur volume de crete et leur hauteur, au lieu de se fier a une oreille.
 */
export function renderCue(
  context: BaseAudioContext,
  destination: AudioNode,
  cue: Cue,
  startAt: number,
): number {
  const notes = CUES[cue];
  let end = startAt;

  for (const note of notes) {
    const begin = startAt + (note.delay ?? 0);
    const stop = begin + note.duration;

    const oscillator = context.createOscillator();
    oscillator.type = note.type;
    oscillator.frequency.setValueAtTime(note.from, begin);
    if (note.to !== note.from) {
      // Glissando exponentiel: l'oreille percoit la hauteur en octaves, pas
      // en hertz. Une rampe lineaire s'entendrait acceleree a la fin.
      oscillator.frequency.exponentialRampToValueAtTime(note.to, stop);
    }

    // Enveloppe: une attaque tres courte evite le claquement d'un depart sec,
    // et une extinction exponentielle donne la queue feutree du film.
    const envelope = context.createGain();
    const peak = note.gain * MASTER;
    envelope.gain.setValueAtTime(0.0001, begin);
    envelope.gain.exponentialRampToValueAtTime(peak, begin + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, stop);

    oscillator.connect(envelope);
    envelope.connect(destination);
    oscillator.start(begin);
    oscillator.stop(stop + 0.02);

    end = Math.max(end, stop);
  }

  return end;
}

/** Duree totale d'un son, en secondes. */
export function cueDuration(cue: Cue): number {
  return CUES[cue].reduce(
    (longest, note) => Math.max(longest, (note.delay ?? 0) + note.duration),
    0,
  );
}

/** Joue les sons de l'interface. */
export class SoundKit {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled: boolean;
  /** Vrai tant que JARVIS parle: on se tait alors completement. */
  private muted = false;

  constructor() {
    this.enabled = readPreference();
    this.armOnFirstGesture();
  }

  /**
   * Ouvre le contexte audio au tout premier geste, quel qu'il soit.
   *
   * Sans cela, le premier clic est muet: `play` decouvre que le contexte
   * n'existe pas, l'ouvre, et laisse passer ce son-la. On perd exactement le
   * son que l'utilisateur attendait le plus — celui qui lui apprend que
   * l'interface repond.
   *
   * L'ecouteur se retire de lui-meme apres le premier declenchement.
   */
  private armOnFirstGesture(): void {
    if (typeof window === "undefined") return;
    const arm = () => {
      void this.resume();
      for (const event of GESTURES) {
        window.removeEventListener(event, arm);
      }
    };
    for (const event of GESTURES) {
      // `capture`: on veut etre appele avant que l'application traite le clic,
      // pour que le contexte soit pret quand elle demande un son.
      window.addEventListener(event, arm, { capture: true, passive: true });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      /* navigation privee: le choix vaut pour la session */
    }
    if (on) void this.resume();
  }

  /** Coupe le son pendant que JARVIS parle. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * Ouvre le contexte audio. A appeler depuis un geste de l'utilisateur.
   *
   * Les navigateurs refusent de demarrer l'audio autrement, et un contexte
   * cree trop tot reste bloque en `suspended` — silencieux sans erreur, ce
   * qui est le pire des cas a diagnostiquer.
   */
  async resume(): Promise<void> {
    if (!this.enabled) return;
    try {
      if (!this.context) {
        const Ctor = getAudioContext();
        if (!Ctor) return;
        this.context = new Ctor();
        this.master = this.context.createGain();
        this.master.gain.value = 1;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === "suspended") await this.context.resume();
    } catch {
      /* audio indisponible: l'interface reste muette, rien de plus */
    }
  }

  play(cue: Cue): void {
    if (!this.enabled || this.muted) return;
    try {
      const context = this.context;
      const master = this.master;
      if (!context || !master || context.state !== "running") {
        // Pas encore autorise par le navigateur: on tente d'ouvrir pour la
        // prochaine fois, sans forcer celui-ci.
        void this.resume();
        return;
      }
      renderCue(context, master, cue, context.currentTime);
    } catch {
      /* un son rate ne casse jamais un tour de parole */
    }
  }

  close(): void {
    try {
      void this.context?.close();
    } catch {
      /* deja ferme */
    }
    this.context = null;
    this.master = null;
  }
}

function readPreference(): boolean {
  try {
    // Actif par defaut: c'est ce qui donne vie a l'interface, et une case
    // permet de l'eteindre en un clic.
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}
