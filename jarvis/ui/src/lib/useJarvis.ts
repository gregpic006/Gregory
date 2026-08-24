import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchOverview, fetchSystem } from "./api";
import { MicRecorder, SpeechPlayer } from "./audio";
import type {
  AssistantState, ChatMessage, Citation, Overview, PendingAction, ServerEvent,
  SystemInfo, ToolActivity,
} from "./types";
import { JarvisSocket } from "./ws";

let counter = 0;
const nextId = () => `m${++counter}`;

/** Etat conversationnel de JARVIS, partage par toutes les vues.
 *
 * Toute la mecanique temps reel vit ici: connexion, streaming, micro, voix,
 * confirmations. Les vues n'en voient que le resultat, ce qui les garde
 * simples et testables a l'oeil.
 */
export function useJarvis() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<AssistantState>("idle");
  const [detail, setDetail] = useState("");
  const [transcript, setTranscript] = useState("");
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);

  const socket = useRef<JarvisSocket | null>(null);
  const recorder = useRef(new MicRecorder());
  const player = useRef(new SpeechPlayer());
  const streamingId = useRef<string | null>(null);
  const serverVoice = useRef(false);
  /** Niveau du micro, lu par le noyau a chaque image. */
  const levelRef = useRef(0);
  const levelRaf = useRef(0);

  const micAvailable = useMemo(
    () => recorder.current.supported && (system?.providers.stt_available ?? false),
    [system?.providers.stt_available],
  );

  const refreshSystem = useCallback(() => {
    fetchSystem()
      .then((info) => {
        setSystem(info);
        serverVoice.current = info.providers.tts_available;
      })
      .catch(() => setError("Le serveur JARVIS ne repond pas. Est-il lance ?"));
  }, []);

  const refreshOverview = useCallback(() => {
    fetchOverview().then(setOverview).catch(() => undefined);
  }, []);

  /** Coupe la parole de JARVIS des que l'utilisateur reprend la main. */
  const bargeIn = useCallback(() => {
    player.current.beginTurn();
    socket.current?.send({ type: "cancel" });
  }, []);

  const appendToken = useCallback((chunk: string) => {
    setMessages((current) => {
      const id = streamingId.current;
      if (id) {
        return current.map((message) =>
          message.id === id ? { ...message, text: message.text + chunk } : message,
        );
      }
      const created = nextId();
      streamingId.current = created;
      return [...current, { id: created, role: "assistant", text: chunk, streaming: true }];
    });
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "state":
          setState(event.state as AssistantState);
          setDetail((event.detail as string) ?? "");
          if (event.system) setSystem(event.system as SystemInfo);
          break;

        case "transcript": {
          const text = event.text as string;
          setTranscript(text);
          setMessages((current) => [...current, { id: nextId(), role: "user", text }]);
          break;
        }

        case "token": {
          const chunk = event.text as string;
          appendToken(chunk);
          if (!serverVoice.current) {
            player.current.pushStreamedText(chunk, system?.language ?? "fr-CA");
          }
          break;
        }

        case "tool_start":
          setActivity((current) =>
            [
              {
                id: nextId(),
                tool: event.tool as string,
                label: event.label as string,
                status: "running" as const,
              },
              ...current,
            ].slice(0, 20),
          );
          break;

        case "tool_end":
          setActivity((current) => {
            const index = current.findIndex(
              (item) => item.tool === event.tool && item.status === "running",
            );
            if (index === -1) return current;
            const copy = [...current];
            copy[index] = {
              ...copy[index],
              status: event.ok ? "ok" : "failed",
              summary: String(event.summary ?? "").slice(0, 90),
            };
            return copy;
          });
          break;

        case "confirmation_required":
          setPending(event.action as PendingAction);
          break;

        case "message": {
          const text = event.text as string;
          const citations = (event.citations as Citation[]) ?? [];
          setMessages((current) => {
            const id = streamingId.current;
            if (id) {
              return current.map((message) =>
                message.id === id
                  ? { ...message, text, citations, streaming: false }
                  : message,
              );
            }
            return [...current, { id: nextId(), role: "assistant", text, citations }];
          });
          streamingId.current = null;
          if (!event.pending_confirmation) setPending(null);
          if (!serverVoice.current) {
            player.current.flushStreamedText(text, system?.language ?? "fr-CA");
          }
          // Une reponse peut avoir cree un rappel ou un evenement: on rafraichit.
          refreshOverview();
          break;
        }

        case "audio":
          serverVoice.current = true;
          player.current.enqueueBase64(event.audio_base64 as string, event.mime as string);
          break;

        case "error":
          setError(event.message as string);
          streamingId.current = null;
          setMessages((current) => current.map((m) => ({ ...m, streaming: false })));
          break;

        default:
          break;
      }
    },
    [appendToken, refreshOverview, system?.language],
  );

  useEffect(() => {
    const connection = new JarvisSocket();
    socket.current = connection;
    const unsubscribe = connection.onEvent(handleEvent);
    connection.connect();
    refreshSystem();
    refreshOverview();
    // Les donnees du jour changent lentement: toutes les deux minutes suffisent.
    const timer = window.setInterval(refreshOverview, 120_000);
    return () => {
      unsubscribe();
      connection.close();
      recorder.current.release();
      window.clearInterval(timer);
      window.clearInterval(timer);
    };
  }, [handleEvent, refreshOverview, refreshSystem]);

  const sendText = useCallback(
    (text: string) => {
      setError("");
      bargeIn();
      streamingId.current = null;
      setTranscript(text);
      setMessages((current) => [...current, { id: nextId(), role: "user", text }]);
      socket.current?.send({ type: "text", text });
      setState("understanding");
    },
    [bargeIn],
  );

  const startRecording = useCallback(async () => {
    if (recording) return;
    if (!micAvailable) {
      setError(
        "La reconnaissance vocale n'est pas configuree (JARVIS_STT_PROVIDER). " +
          "Ecris ta demande — tout fonctionne aussi en texte.",
      );
      return;
    }
    setError("");
    bargeIn();
    try {
      await recorder.current.start();
      setRecording(true);
      setState("listening");
      // Le noyau lit ce niveau a chaque image: la boucle doit tourner tant
      // qu'on ecoute, et s'arreter ensuite.
      const follow = () => {
        levelRef.current = recorder.current.level();
        levelRaf.current = requestAnimationFrame(follow);
      };
      levelRaf.current = requestAnimationFrame(follow);
    } catch {
      setError("Acces au micro refuse. Utilise le mode texte.");
    }
  }, [bargeIn, micAvailable, recording]);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(false);
    cancelAnimationFrame(levelRaf.current);
    levelRef.current = 0;
    setState("transcribing");
    const captured = await recorder.current.stop();
    if (!captured) {
      setState("idle");
      return;
    }
    socket.current?.send({
      type: "audio",
      audio_base64: captured.base64,
      mime: captured.mime,
    });
  }, [recording]);

  const decide = useCallback((approved: boolean) => {
    setPending((action) => {
      if (action) {
        socket.current?.send({ type: "confirm", action_id: action.action_id, approved });
      }
      return null;
    });
  }, []);

  const lastTurn = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant") ?? null,
    [messages],
  );

  return {
    system, overview, messages, state, detail, transcript, activity, pending, error,
    recording, micAvailable, levelRef, lastTurn, player: player.current,
    sendText, startRecording, stopRecording, decide, refreshSystem, refreshOverview,
    dismissError: () => setError(""),
  };
}
