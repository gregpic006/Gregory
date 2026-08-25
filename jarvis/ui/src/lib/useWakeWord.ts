/**
 * Mot d'eveil: « Salut JARVIS » prononce a voix haute demarre l'ecoute.
 *
 * Deux mots plutot qu'un: « jarvis » seul revient trop souvent dans une
 * conversation normale — en parlant de l'assistant a quelqu'un, par exemple —
 * et declencherait l'ecoute a contretemps.
 *
 * Utilise la reconnaissance vocale du navigateur (Edge et Chrome sous
 * Windows). Aucun modele a telecharger, aucun service a installer.
 *
 * Le risque de cette fonctionnalite est le conflit de micro: deux
 * consommateurs qui reclament le peripherique en meme temps, et c'est la
 * commande vocale existante qui casse. Trois regles l'evitent.
 *
 * 1. **Un seul consommateur a la fois.** Des que la phrase est reconnue, l'ecoute
 *    passive s'arrete *avant* que l'enregistrement ne demarre. Elle ne
 *    reprend qu'une fois le tour termine.
 * 2. **Jamais pendant que JARVIS parle**, sinon il se reveillerait lui-meme en
 *    entendant son propre nom dans sa reponse.
 * 3. **Desactive par defaut.** Tant que l'utilisateur ne l'active pas, ce
 *    module ne touche pas au micro — le push-to-talk garde le comportement
 *    qu'il a toujours eu.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { AssistantState } from "./types";

const STORAGE_KEY = "jarvis.wakeword";

/** Variantes du salut et du nom.
 *
 * La reconnaissance transcrit rarement « JARVIS » exactement: elle propose
 * « jarvice », « darvis », parfois « java is ». On accepte donc un eventail,
 * mais on exige **les deux mots** — « jarvis » seul revient trop souvent dans
 * une conversation normale pour servir de declencheur.
 */
const GREETINGS = ["salut", "salu", "sallut", "salut,"];
const NAMES = ["jarvis", "jarvice", "jarviss", "jarvi", "darvis", "charvis", "java is"];

/** « salut » suivi du nom, avec au plus un mot parasite entre les deux. */
const WAKE_PATTERN = new RegExp(
  `\\b(?:${GREETINGS.join("|")})\\b(?:\\s+\\S+)?\\s+(?:${NAMES.join("|")})\\b`,
);

/** Etats pendant lesquels l'ecoute passive doit rester coupee. */
const BUSY_STATES: AssistantState[] = ["listening", "transcribing", "speaking"];

type RecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognition(): RecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Normalise avant comparaison: la transcription arrive accentuee et ponctuee. */
export function normalizeSpeech(transcript: string): string {
  return transcript
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vrai si « salut JARVIS » a ete prononce. */
export function heard(transcript: string): boolean {
  return WAKE_PATTERN.test(normalizeSpeech(transcript));
}

export interface WakeWordState {
  /** Vrai si le navigateur sait faire de la reconnaissance continue. */
  supported: boolean;
  enabled: boolean;
  /** Vrai quand l'ecoute passive tourne reellement. */
  awake: boolean;
  error: string;
  toggle: () => void;
}

export function useWakeWord(options: {
  state: AssistantState;
  micAvailable: boolean;
  onWake: () => void;
}): WakeWordState {
  const { state, micAvailable, onWake } = options;

  const [supported] = useState(() => getRecognition() !== null);
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      return false;
    }
  });
  const [awake, setAwake] = useState(false);
  const [error, setError] = useState("");

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const wanted = useRef(false);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  // L'ecoute passive ne doit tourner que si elle est voulue, possible, et que
  // rien d'autre n'occupe le micro.
  const shouldListen = enabled && supported && micAvailable && !BUSY_STATES.includes(state);

  const stop = useCallback(() => {
    wanted.current = false;
    const engine = recognition.current;
    recognition.current = null;
    setAwake(false);
    if (!engine) return;
    engine.onend = null;
    engine.onresult = null;
    engine.onerror = null;
    try {
      engine.abort();
    } catch {
      /* le moteur etait deja arrete */
    }
  }, []);

  useEffect(() => {
    if (!shouldListen) {
      stop();
      return;
    }
    if (recognition.current) return;

    const Recognition = getRecognition();
    if (!Recognition) return;

    const engine = new Recognition();
    engine.lang = "fr-CA";
    engine.continuous = true;
    engine.interimResults = true;
    wanted.current = true;
    recognition.current = engine;

    engine.onresult = (event) => {
      const results = Array.from({ length: event.results.length }, (_, i) => event.results[i]);
      const spoken = results
        .map((result) => result[0]?.transcript ?? "")
        .join(" ");
      if (!heard(spoken)) return;
      // On coupe l'ecoute passive AVANT de rendre la main: le micro ne doit
      // jamais avoir deux consommateurs en meme temps.
      stop();
      onWakeRef.current();
    };

    engine.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Acces au micro refuse: le mot d'eveil ne peut pas fonctionner.");
        setEnabled(false);
        stop();
        return;
      }
      // « no-speech » et « aborted » sont normaux; onend relancera.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setError("");
      }
    };

    engine.onend = () => {
      // Le moteur s'arrete tout seul apres quelques secondes de silence.
      // Tant que l'ecoute reste voulue, on le relance.
      if (!wanted.current || recognition.current !== engine) return;
      try {
        engine.start();
      } catch {
        recognition.current = null;
        setAwake(false);
      }
    };

    try {
      engine.start();
      setAwake(true);
      setError("");
    } catch {
      recognition.current = null;
      setAwake(false);
    }

    return () => {
      stop();
    };
  }, [shouldListen, stop]);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
      } catch {
        /* le reglage vaudra pour cette session */
      }
      if (!next) setError("");
      return next;
    });
  }, []);

  return { supported, enabled, awake, error, toggle };
}
