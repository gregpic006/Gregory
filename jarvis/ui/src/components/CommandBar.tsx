import { useState } from "react";

import { IconMic } from "./layout/icons";

interface Props {
  onSend: (text: string) => void;
  onMicDown: () => void;
  onMicUp: () => void;
  recording: boolean;
  micAvailable: boolean;
}

/** Barre de commande: ecrire ou parler, toujours accessible.
 *
 * La voix est centrale, mais tout doit rester faisable au clavier — c'est ce
 * qui permet de deboguer le cerveau sans dependre du micro.
 */
export function CommandBar({ onSend, onMicDown, onMicUp, recording, micAvailable }: Props) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="commandbar">
      <div className="commandbar-inner">
        <input
          value={text}
          placeholder="Demande n'importe quoi a JARVIS…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="mic-btn"
          data-active={recording}
          disabled={!micAvailable}
          onMouseDown={onMicDown}
          onMouseUp={onMicUp}
          onMouseLeave={() => recording && onMicUp()}
          title={micAvailable ? "Maintenir pour parler (Espace)" : "Aucun moteur vocal configure"}
          aria-label="Parler"
        >
          <IconMic size={16} />
        </button>
        <button className="send-btn" onClick={submit} disabled={!text.trim()}>
          Envoyer
        </button>
      </div>
      <div className="commandbar-hint">
        {micAvailable ? (
          <>
            <kbd>Espace</kbd> parler · <kbd>Ctrl</kbd>+<kbd>K</kbd> rechercher ·
            parler pendant la reponse l'interrompt
          </>
        ) : (
          <>
            <kbd>Entree</kbd> envoyer · <kbd>Ctrl</kbd>+<kbd>K</kbd> rechercher ·
            voix inactive
          </>
        )}
      </div>
    </div>
  );
}
