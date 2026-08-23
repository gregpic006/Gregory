import { useEffect, useState } from "react";

import type { SpeechPlayer } from "../lib/audio";

interface Props {
  player: SpeechPlayer;
  language: string;
  /** Vrai si un moteur serveur est actif: le choix navigateur devient inutile. */
  serverVoice: boolean;
}

/** Choix de la voix du systeme.
 *
 * Le classement automatique reste une supposition; c'est l'oreille qui tranche.
 * Le bouton d'ecoute permet de comparer sans lancer un vrai tour de parole.
 */
export function VoicePicker({ player, language, serverVoice }: Props) {
  const [voices, setVoices] = useState<{ name: string; lang: string; natural: boolean }[]>([]);
  const [selected, setSelected] = useState("");

  useEffect(() => {
    const refresh = () => {
      const available = player.availableVoices();
      setVoices(available);
      if (available.length > 0) setSelected(player.voiceName());
    };
    refresh();
    // La liste des voix arrive de facon asynchrone selon le navigateur.
    window.speechSynthesis?.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", refresh);
  }, [player]);

  if (serverVoice || voices.length === 0) return null;

  const natural = voices.filter((v) => v.natural).length;

  return (
    <section className="panel">
      <h2>Voix du systeme</h2>

      <select
        className="voice-select"
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value);
          player.setVoice(event.target.value);
        }}
      >
        {voices.map((voice) => (
          <option key={voice.name} value={voice.name}>
            {voice.natural ? "★ " : ""}
            {voice.name.replace("Microsoft ", "")} — {voice.lang}
          </option>
        ))}
      </select>

      <div className="integration-actions">
        <button className="btn small" onClick={() => player.preview(selected, language)}>
          Ecouter
        </button>
      </div>

      {natural === 0 && (
        <div className="integration-detail">
          Aucune voix naturelle detectee. Ouvre l'interface dans <b>Microsoft Edge</b> :
          il expose des voix nettement meilleures, sans rien installer.
        </div>
      )}
    </section>
  );
}
