import { useEffect, useState } from "react";

import { Card } from "../components/Card";
import { IconGear, IconMic, IconRefresh } from "../components/layout/icons";
import {
  checkForUpdate,
  fetchMetrics,
  fetchSettings,
  installUpdate,
  readVoiceConfig,
  saveVoice,
  testVoice,
  updateSettings,
  type MetricsSnapshot,
  type SettingsResponse,
  type UpdateStatus,
  type VoiceConfig,
} from "../lib/api";
import type { SpeechPlayer } from "../lib/audio";
import type { SoundKit } from "../lib/sound";
import type { WakeWordState } from "../lib/useWakeWord";
import type { SystemInfo } from "../lib/types";

interface Props {
  system: SystemInfo | null;
  player: SpeechPlayer;
  wake: WakeWordState;
  sound: SoundKit;
}

/** Reglages.
 *
 * Les interrupteurs ecrivent directement dans `.env`: personne ne devrait
 * avoir a ouvrir un fichier texte et trouver la bonne ligne pour activer une
 * fonctionnalite. Les cles d'API, elles, n'apparaissent jamais ici — ni en
 * lecture ni en ecriture.
 */
export function SettingsView({ system, player, wake, sound }: Props) {
  const [voices, setVoices] = useState<{ name: string; lang: string; natural: boolean }[]>([]);
  const [selected, setSelected] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [config, setConfig] = useState<SettingsResponse | null>(null);
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateNote, setUpdateNote] = useState("");
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null);
  const [voicePick, setVoicePick] = useState("");
  const [deliveryPick, setDeliveryPick] = useState("");
  const [addressPick, setAddressPick] = useState("monsieur");
  const [accentPick, setAccentPick] = useState("britannique");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");
  const [soundOn, setSoundOn] = useState(() => sound.isEnabled());

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
    checkForUpdate().then(setUpdate).catch(() => undefined);
    readVoiceConfig()
      .then((config) => {
        setVoiceConfig(config);
        // La voix affichee est celle reellement utilisee, pas le reglage brut:
        // « automatique » ne dit pas ce qu'on entend.
        setVoicePick(config.voice || config.resolved);
        setDeliveryPick(config.delivery);
        setAddressPick(config.address === "familier" ? "familier" : "monsieur");
        setAccentPick(config.accent || "britannique");
      })
      .catch(() => undefined);
  }, []);

  /** Fait entendre la voix choisie sans rien enregistrer. */
  const hearVoice = async () => {
    setVoiceBusy(true);
    setVoiceNote("");
    try {
      const sample = await testVoice({ voice: voicePick, delivery: deliveryPick });
      const audio = new Audio(`data:${sample.mime};base64,${sample.audio}`);
      await audio.play();
    } catch (cause) {
      setVoiceNote(cause instanceof Error ? cause.message : "Essai impossible.");
    } finally {
      setVoiceBusy(false);
    }
  };

  const keepVoice = async () => {
    setVoiceBusy(true);
    setVoiceNote("");
    try {
      await saveVoice({
        voice: voicePick,
        delivery: deliveryPick,
        address: addressPick,
        accent: accentPick,
      });
      setVoiceNote("Voix enregistree. Elle vaut des la prochaine phrase.");
    } catch (cause) {
      setVoiceNote(cause instanceof Error ? cause.message : "Enregistrement impossible.");
    } finally {
      setVoiceBusy(false);
    }
  };

  const runUpdate = async () => {
    setUpdating(true);
    setUpdateNote("");
    try {
      const result = await installUpdate();
      if (result.error) {
        setUpdateNote(result.error);
      } else if (result.restarted) {
        // Le serveur redemarre: la page doit se recharger apres, pas avant.
        setUpdateNote("Mise a jour installee. JARVIS redemarre…");
        window.setTimeout(() => window.location.reload(), 6000);
      } else {
        setUpdateNote(result.detail);
      }
    } catch {
      setUpdateNote("La mise a jour a echoue.");
    } finally {
      setUpdating(false);
    }
  };

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

      {/* Hors de la grille des reglages: une mise a jour est une action,
          pas une option, et elle occupe toute la largeur. */}
      <div className="grid">
        <Card
          title="Mise a jour"
          icon={<IconRefresh />}
          count={update?.available ? "disponible" : ""}
        >
          <div className="stack">
            {update === null ? (
              <p className="card-empty">Verification…</p>
            ) : update.error ? (
              <p className="card-empty">{update.error}</p>
            ) : update.blocked ? (
              <p className="card-empty">{update.blocked}</p>
            ) : update.available ? (
              <>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  {update.behind} changement(s) disponible(s).
                </p>
                {update.changes.length > 0 && (
                  <div className="stack" style={{ gap: 4 }}>
                    {update.changes.slice(0, 5).map((line) => (
                      <span className="card-empty" key={line}>
                        · {line}
                      </span>
                    ))}
                  </div>
                )}
                <button className="btn primary" onClick={runUpdate} disabled={updating}>
                  {updating ? "Mise a jour…" : "Mettre a jour et redemarrer"}
                </button>
              </>
            ) : (
              <p className="card-empty">
                JARVIS est a jour (version {update.current || "inconnue"}).
              </p>
            )}
            {updateNote && <p className="card-empty">{updateNote}</p>}
          </div>
        </Card>
      </div>

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
                      Dire « Salut JARVIS » pour parler
                      {wake.enabled && wake.awake && (
                        <span className="switch-tag accent">a l'ecoute</span>
                      )}
                    </span>
                    <span className="switch-desc">
                      Le micro reste ouvert en permanence pour reconnaitre ton appel.
                      Il faut les deux mots: « jarvis » seul reviendrait trop souvent
                      dans une conversation. L'ecoute se coupe pendant que JARVIS parle
                      et pendant que tu lui parles: un seul usage du micro a la fois.
                    </span>
                  </span>
                </label>
                {wake.error && <p className="card-empty">{wake.error}</p>}
                <p className="card-empty">
                  Le navigateur demandera l'acces au micro. Tout reste sur ta machine:
                  la reconnaissance de la phrase est faite par Windows, rien n'est
                  envoye tant que tu n'as pas dit « Salut JARVIS ».
                </p>
              </>
            )}
          </div>
        </Card>

        <Card title="Voix de reponse" icon={<IconMic size={14} />}>
          <div className="stack">
            {voiceConfig === null ? (
              <p className="card-empty">Chargement des voix…</p>
            ) : voiceConfig.provider !== "edge" || voiceConfig.error ? (
              <>
                <p className="card-empty">
                  {voiceConfig.error
                    ? voiceConfig.error + " JARVIS parle avec la voix du systeme."
                    : `Moteur serveur actif: ${voiceConfig.provider}. Le timbre se regle dans .env.`}
                </p>
                {voices.length > 0 && (
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
                    <button
                      className="btn small"
                      onClick={() => player.preview(selected, system?.language ?? "fr-CA")}
                    >
                      Ecouter
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="voice-accent">Accent</label>
                  <select
                    id="voice-accent"
                    className="input"
                    value={accentPick}
                    onChange={(event) => {
                      const next = event.target.value;
                      setAccentPick(next);
                      // La liste est classee selon l'accent: on remonte la
                      // meilleure voix du nouvel accent, sinon le timbre
                      // affiche resterait celui de l'ancien.
                      const best = voiceConfig.voices.find((voice) =>
                        next === "britannique" ? voice.british : voice.locale.startsWith("fr"),
                      );
                      if (best) setVoicePick(best.id);
                    }}
                  >
                    <option value="britannique">
                      Britannique — le majordome des films
                    </option>
                    <option value="quebecois">Quebecois</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="voice-pick">Timbre</label>
                  <select
                    id="voice-pick"
                    className="input"
                    value={voicePick}
                    onChange={(event) => setVoicePick(event.target.value)}
                  >
                    {voiceConfig.voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.british ? "★ " : ""}
                        {voice.label} — {voice.gender === "Male" ? "homme" : "femme"}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="voice-delivery">Tenue</label>
                  <select
                    id="voice-delivery"
                    className="input"
                    value={deliveryPick}
                    onChange={(event) => setDeliveryPick(event.target.value)}
                  >
                    {voiceConfig.deliveries.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label} — {item.description}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={soundOn}
                    onChange={(event) => {
                      const on = event.target.checked;
                      sound.setEnabled(on);
                      setSoundOn(on);
                      if (on) sound.play("tap");
                    }}
                  />
                  <span className="switch-text">
                    <span className="switch-label">Sons de l'interface</span>
                    <span className="switch-desc">
                      Une pression quand tu cliques, un signal au reveil, un autre
                      quand la reponse arrive. Jamais pendant qu'il parle.
                    </span>
                  </span>
                </label>

                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={addressPick === "monsieur"}
                    onChange={(event) =>
                      setAddressPick(event.target.checked ? "monsieur" : "familier")
                    }
                  />
                  <span className="switch-text">
                    <span className="switch-label">Vouvoiement et « Monsieur »</span>
                    <span className="switch-desc">
                      Le registre des films. Decoche pour qu'il te tutoie.
                    </span>
                  </span>
                </label>

                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn small" onClick={hearVoice} disabled={voiceBusy}>
                    {voiceBusy ? "…" : "Ecouter"}
                  </button>
                  <button className="btn primary small" onClick={keepVoice} disabled={voiceBusy}>
                    Garder cette voix
                  </button>
                </div>

                {voiceNote && <p className="card-empty">{voiceNote}</p>}
                {voiceConfig.error && <p className="card-empty">{voiceConfig.error}</p>}
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
