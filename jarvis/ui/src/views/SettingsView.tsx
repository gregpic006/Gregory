import { useEffect, useState } from "react";

import { Card } from "../components/Card";
import { IconGear, IconMic } from "../components/layout/icons";
import {
  fetchMetrics,
  fetchSettings,
  updateSettings,
  type MetricsSnapshot,
  type SettingsResponse,
} from "../lib/api";
import type { SpeechPlayer } from "../lib/audio";
import type { WakeWordState } from "../lib/useWakeWord";
import type { SystemInfo } from "../lib/types";

interface Props {
  system: SystemInfo | null;
  player: SpeechPlayer;
  wake: WakeWordState;
}

/** Reglages.
 *
 * Les interrupteurs ecrivent directement dans `.env`: personne ne devrait
 * avoir a ouvrir un fichier texte et trouver la bonne ligne pour activer une
 * fonctionnalite. Les cles d'API, elles, n'apparaissent jamais ici — ni en
 * lecture ni en ecriture.
 */
export function SettingsView({ system, player, wake }: Props) {
  const [voices, setVoices] = useState<{ name: string; lang: string; natural: boolean }[]>([]);
  const [selected, setSelected] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [config, setConfig] = useState<SettingsResponse | null>(null);
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const refresh = () => {
      const available = player.availableVoices();
      setVoices(available);
      if (available.length > 0) setSelected(player.voiceName());
    };
    refresh();
    window.speechSynthesis?.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", refresh);
  }, [player]);

  useEffect(() => {
    // Les noms de peripheriques ne sont exposes qu'apres autorisation du micro:
    // sans elle, la liste existe mais reste anonyme. On l'affiche telle quelle.
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setDevices(all.filter((device) => device.kind !== "videoinput")))
      .catch(() => undefined);
    fetchMetrics().then(setMetrics).catch(() => undefined);
    fetchSettings().then(setConfig).catch(() => undefined);
  }, []);

  const toggle = async (key: string, enabled: boolean) => {
    setPending(key);
    setError("");
    try {
      const result = await updateSettings({ features: { [key]: enabled } });
      setConfig(await fetchSettings());
      if (result.restart_needed) {
        setNotice(
          result.reconnect_google
            ? "Enregistre. Redemarre JARVIS, puis reconnecte Google dans Integrations."
            : "Enregistre. Le changement prend effet au prochain demarrage de JARVIS.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Modification impossible.");
    } finally {
      setPending("");
    }
  };

  const inputs = devices.filter((device) => device.kind === "audioinput");
  const outputs = devices.filter((device) => device.kind === "audiooutput");

  return (
    <>
      <div className="dash-head">
        <h1>Reglages</h1>
        <p>Coche ce que tu veux activer. Pas besoin d'ouvrir de fichier.</p>
      </div>

      {notice && <div className="banner info">{notice}</div>}
      {error && <div className="banner">{error}</div>}

      <div className="grid">
        <Card title="Fonctionnalites" icon={<IconGear size={14} />}>
          <div className="stack">
            {config === null ? (
              <p className="card-empty">Chargement…</p>
            ) : (
              config.features.map((feature) => (
                <label className="switch-row" key={feature.key}>
                  <input
                    type="checkbox"
                    checked={feature.enabled}
                    disabled={pending === feature.key}
                    onChange={(event) => toggle(feature.key, event.target.checked)}
                  />
                  <span className="switch-text">
                    <span className="switch-label">
                      {feature.label}
                      {feature.needs_reconnect && feature.enabled === false && (
                        <span className="switch-tag">reconnexion Google</span>
                      )}
                    </span>
                    <span className="switch-desc">{feature.description}</span>
                  </span>
                </label>
              ))
            )}
            <p className="card-empty">
              Le controle de l'ordinateur et le mode autonome ne sont volontairement
              pas modifiables ici: une capacite qui agit seule sur ta machine ne doit
              pas s'activer d'un clic.
            </p>
          </div>
        </Card>

        <Card title="Mot d'eveil" icon={<IconMic size={14} />}>
          <div className="stack">
            {!wake.supported ? (
              <p className="card-empty">
                Ton navigateur ne sait pas ecouter en continu. Ouvre JARVIS dans{" "}
                <b>Microsoft Edge</b> ou <b>Chrome</b> pour utiliser le mot d'eveil.
              </p>
            ) : !system?.providers.stt_available ? (
              <p className="card-empty">
                La reconnaissance vocale du serveur n'est pas configuree
                (JARVIS_STT_PROVIDER): le mot d'eveil n'aurait rien pour transcrire.
              </p>
            ) : (
              <>
                <label className="switch-row">
                  <input type="checkbox" checked={wake.enabled} onChange={wake.toggle} />
                  <span className="switch-text">
                    <span className="switch-label">
                      Dire « JARVIS » pour parler
                      {wake.enabled && wake.awake && (
                        <span className="switch-tag accent">a l'ecoute</span>
                      )}
                    </span>
                    <span className="switch-desc">
                      Le micro reste ouvert en permanence pour reconnaitre ton appel.
                      L'ecoute se coupe pendant que JARVIS parle et pendant que tu lui
                      parles: un seul usage du micro a la fois.
                    </span>
                  </span>
                </label>
                {wake.error && <p className="card-empty">{wake.error}</p>}
                <p className="card-empty">
                  Le navigateur demandera l'acces au micro. Tout reste sur ta machine:
                  la reconnaissance du mot est faite par Windows, rien n'est envoye
                  tant que tu n'as pas dit « JARVIS ».
                </p>
              </>
            )}
          </div>
        </Card>

        <Card title="Voix de reponse" icon={<IconMic size={14} />}>
          <div className="stack">
            {system?.providers.tts_available ? (
              <p className="card-empty">
                Moteur serveur actif: <b>{system.providers.tts}</b>. Le timbre se regle
                dans .env (JARVIS_TTS_STABILITY, JARVIS_TTS_STYLE).
              </p>
            ) : (
              <>
                <select
                  className="input"
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
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn small"
                    onClick={() => player.preview(selected, system?.language ?? "fr-CA")}
                  >
                    Ecouter
                  </button>
                </div>
                {voices.every((voice) => !voice.natural) && (
                  <p className="card-empty">
                    Aucune voix naturelle detectee. Ouvre JARVIS dans <b>Microsoft Edge</b>:
                    il expose des voix nettement meilleures, sans rien installer.
                  </p>
                )}
              </>
            )}
          </div>
        </Card>

        <Card title="Peripheriques audio" icon={<IconMic size={14} />}>
          <div className="stack">
            <div className="field">
              <span className="k">Microphone</span>
              <span className="v">
                {inputs[0]?.label || (inputs.length ? "peripherique par defaut" : "aucun")}
              </span>
            </div>
            <div className="field">
              <span className="k">Sortie</span>
              <span className="v">
                {outputs[0]?.label || (outputs.length ? "peripherique par defaut" : "systeme")}
              </span>
            </div>
            <p className="card-empty">
              JARVIS utilise le peripherique par defaut de Windows. Rien a configurer:
              change-le dans Windows et il suivra.
            </p>
          </div>
        </Card>

        <Card title="Systeme" icon={<IconGear size={14} />}>
          <div className="stack">
            <div className="field">
              <span className="k">Raisonnement</span>
              <span className={`v ${system?.providers.llm === "mock" ? "off" : "on"}`}>
                {system?.providers.llm}
              </span>
            </div>
            <div className="field">
              <span className="k">Modele</span>
              <span className="v">{system?.providers.llm_models.balanced}</span>
            </div>
            <div className="field">
              <span className="k">Transcription</span>
              <span className={`v ${system?.providers.stt_available ? "on" : "off"}`}>
                {system?.providers.stt}
              </span>
            </div>
            <div className="field">
              <span className="k">Fuseau</span>
              <span className="v">{system?.timezone}</span>
            </div>
            <div className="field">
              <span className="k">Mode</span>
              <span className="v">{system?.dry_run ? "simulation" : "reel"}</span>
            </div>
          </div>
        </Card>

        <Card title="Outils" icon={<IconGear size={14} />} count={system?.tools.filter((t) => t.available).length}>
          <div className="pill-row">
            {(system?.tools ?? []).map((tool) => (
              <span
                className="tool-pill"
                key={tool.name}
                data-available={tool.available}
                data-level={tool.permission}
                title={`${tool.description} (palier ${tool.permission})`}
              >
                {tool.name}
              </span>
            ))}
          </div>
        </Card>

        {metrics && (
          <Card title="Mesures" icon={<IconGear size={14} />}>
            <div className="stack">
              <div className="field">
                <span className="k">Tours</span>
                <span className="v">{metrics.turns}</span>
              </div>
              <div className="field">
                <span className="k">Latence p50</span>
                <span className="v">{metrics.latency_ms.turn.p50} ms</span>
              </div>
              <div className="field">
                <span className="k">Latence p95</span>
                <span className="v">{metrics.latency_ms.turn.p95} ms</span>
              </div>
              <div className="field">
                <span className="k">Echec outils</span>
                <span className="v">{Math.round(metrics.tools.failure_rate * 100)} %</span>
              </div>
              <div className="field">
                <span className="k">Cout du jour</span>
                <span className="v">{(metrics.llm_spend.spent_usd ?? 0).toFixed(3)} $ US</span>
              </div>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
