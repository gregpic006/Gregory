import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Composer } from "./components/Composer";
import { ConfirmBar } from "./components/ConfirmBar";
import { Conversation } from "./components/Conversation";
import { Orb } from "./components/Orb";
import { SidePanel } from "./components/SidePanel";
import { fetchMetrics, fetchSystem, type MetricsSnapshot } from "./lib/api";
import { MicRecorder, SpeechPlayer } from "./lib/audio";
import type {
  AssistantState,
  ChatMessage,
  Citation,
  PendingAction,
  ServerEvent,
  SystemInfo,
  ToolActivity,
} from "./lib/types";
import { JarvisSocket } from "./lib/ws";

let counter = 0;
const nextId = () => `m${++counter}`;

function greetingFor(name: string): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Bonne nuit.";
  if (hour < 12) return "Bon matin.";
  if (hour < 18) return `Bon apres-midi${name ? `, ${name}` : ""}.`;
  return `Bonsoir${name ? `, ${name}` : ""}.`;
}

export default function App() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<AssistantState>("idle");
  const [detail, setDetail] = useState("");
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);

  const socket = useRef<JarvisSocket | null>(null);
  const recorder = useRef(new MicRecorder());
  const player = useRef(new SpeechPlayer());
  const streamingId = useRef<string | null>(null);
  const serverVoice = useRef(false);

  const assistantName = system?.name ?? "Jarvis";
  const greeting = useMemo(() => greetingFor(system?.user ?? ""), [system?.user]);

  /** Interrompt la parole de JARVIS des que l'utilisateur reprend la main. */
  /** Le micro n'est utilisable que si un moteur de transcription existe.
   *  Sans cette condition, on demanderait l'acces au micro pour finalement
   *  echouer a la transcription — la pire des sequences pour l'utilisateur. */
  const micAvailable =
    recorder.current.supported && (system?.providers.stt_available ?? false);

  const bargeIn = useCallback(() => {
    player.current.stop();
    socket.current?.send({ type: "cancel" });
  }, []);

  const appendToken = useCallback((text: string) => {
    setMessages((current) => {
      const id = streamingId.current;
      if (id) {
        return current.map((message) =>
          message.id === id ? { ...message, text: message.text + text } : message,
        );
      }
      const created = nextId();
      streamingId.current = created;
      return [...current, { id: created, role: "assistant", text, streaming: true }];
    });
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "state": {
          setState(event.state as AssistantState);
          setDetail((event.detail as string) ?? "");
          if (event.system) setSystem(event.system as SystemInfo);
          break;
        }
        case "transcript": {
          const text = event.text as string;
          setMessages((current) => [...current, { id: nextId(), role: "user", text }]);
          break;
        }
        case "token":
          appendToken(event.text as string);
          break;
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
          // Aucun moteur de voix serveur: on lit avec la voix du systeme.
          if (!serverVoice.current) {
            player.current.speakWithSystemVoice(text, system?.language ?? "fr-CA");
          }
          void fetchMetrics().then(setMetrics).catch(() => undefined);
          break;
        }
        case "audio":
          serverVoice.current = true;
          player.current.enqueueBase64(
            event.audio_base64 as string,
            event.mime as string,
          );
          break;
        case "error":
          setError(event.message as string);
          streamingId.current = null;
          setMessages((current) =>
            current.map((message) => ({ ...message, streaming: false })),
          );
          break;
        default:
          break;
      }
    },
    [appendToken, system?.language],
  );

  useEffect(() => {
    const connection = new JarvisSocket();
    socket.current = connection;
    const unsubscribe = connection.onEvent(handleEvent);
    connection.connect();
    fetchSystem()
      .then((info) => {
        setSystem(info);
        serverVoice.current = info.providers.tts_available;
      })
      .catch(() => setError("Le serveur JARVIS ne repond pas. Est-il lance?"));
    return () => {
      unsubscribe();
      connection.close();
      recorder.current.release();
    };
  }, [handleEvent]);

  const refreshSystem = useCallback(() => {
    fetchSystem()
      .then((info) => {
        setSystem(info);
        serverVoice.current = info.providers.tts_available;
      })
      .catch(() => undefined);
  }, []);

  const sendText = useCallback(
    (text: string) => {
      setError("");
      bargeIn();
      streamingId.current = null;
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
          "Ecris ta demande ci-dessous — tout fonctionne aussi en texte.",
      );
      return;
    }
    setError("");
    bargeIn();
    try {
      await recorder.current.start();
      setRecording(true);
      setState("listening");
    } catch {
      setError("Acces au micro refuse. Utilise le mode texte.");
    }
  }, [bargeIn, micAvailable, recording]);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(false);
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

  // Push-to-talk au clavier: Espace maintenu, hors champ de saisie.
  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === "TEXTAREA" || target.tagName === "INPUT");

    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isTyping(event.target)) return;
      if (!micAvailable) return;
      event.preventDefault();
      void startRecording();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTyping(event.target)) return;
      if (!micAvailable) return;
      event.preventDefault();
      void stopRecording();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [micAvailable, startRecording, stopRecording]);

  const decide = (approved: boolean) => {
    if (!pending) return;
    socket.current?.send({
      type: "confirm",
      action_id: pending.action_id,
      approved,
    });
    setPending(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">{assistantName}</span>
        {system?.dry_run && <span className="chip warn">mode developpement</span>}
        {system?.providers.llm === "mock" && (
          <span className="chip warn">moteur local — sans LLM</span>
        )}
        {!micAvailable && <span className="chip">voix desactivee</span>}
        <span className="spacer" />
        <span className="chip">{system?.providers.llm_models.balanced ?? "…"}</span>
        <span className="chip ok">{system?.timezone ?? ""}</span>
      </header>

      <main className="main">
        <Orb state={state} greeting={greeting} detail={detail} />
        {error && <div className="banner">{error}</div>}
        <Conversation messages={messages} assistantName={assistantName} />
        {pending && <ConfirmBar action={pending} onDecision={decide} />}
        <div className="hint">
          {micAvailable
            ? "Espace = parler · Entree = envoyer · parler pendant la reponse l'interrompt"
            : "Entree = envoyer · voix desactivee: aucun moteur de transcription configure"}
        </div>
        <Composer
          onSend={sendText}
          onMicDown={() => void startRecording()}
          onMicUp={() => void stopRecording()}
          recording={recording}
          micAvailable={micAvailable}
          disabled={false}
        />
      </main>

      <SidePanel
        system={system}
        activity={activity}
        metrics={metrics}
        onIntegrationsChanged={refreshSystem}
      />
    </div>
  );
}
