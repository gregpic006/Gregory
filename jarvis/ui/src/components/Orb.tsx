import type { AssistantState } from "../lib/types";

const LABELS: Record<AssistantState, string> = {
  idle: "en veille",
  listening: "j'ecoute…",
  transcribing: "transcription…",
  understanding: "je comprends…",
  working: "je cherche…",
  speaking: "je reponds…",
};

interface Props {
  state: AssistantState;
  greeting: string;
  detail?: string;
}

/** Indicateur d'etat: ce que JARVIS fait, en clair. */
export function Orb({ state, greeting, detail }: Props) {
  return (
    <div className="stage">
      <div className="orb" data-state={state} />
      <div className="stage-label">
        <strong>{greeting}</strong>
        <span>{detail || LABELS[state]}</span>
      </div>
    </div>
  );
}
