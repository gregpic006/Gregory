import { useState } from "react";

interface Props {
  onSend: (text: string) => void;
  onMicDown: () => void;
  onMicUp: () => void;
  recording: boolean;
  micAvailable: boolean;
  disabled: boolean;
}

/** Saisie texte + push-to-talk. Le mode texte fait tout ce que fait la voix. */
export function Composer({
  onSend,
  onMicDown,
  onMicUp,
  recording,
  micAvailable,
  disabled,
}: Props) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder="Ecris ta demande, ou maintiens Espace pour parler…"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button
        className="mic"
        data-active={recording}
        disabled={!micAvailable || disabled}
        onMouseDown={onMicDown}
        onMouseUp={onMicUp}
        onMouseLeave={() => recording && onMicUp()}
        title={micAvailable ? "Maintenir pour parler" : "Micro indisponible"}
        aria-label="Parler"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v4" strokeLinecap="round" />
        </svg>
      </button>
      <button className="btn" onClick={submit} disabled={!text.trim()}>
        Envoyer
      </button>
    </div>
  );
}
