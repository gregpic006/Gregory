/** Capture micro (push-to-talk) et lecture de la reponse.
 *
 * Deux details qui comptent pour la sensation de conversation:
 * - le flux micro est garde ouvert entre deux prises de parole, pour eviter la
 *   latence d'autorisation a chaque appui;
 * - `stopSpeaking()` coupe immediatement la lecture (barge-in): des que
 *   l'utilisateur reprend la parole, JARVIS se tait.
 */

export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;

  /** Niveau sonore instantane, 0..1.
   *
   * Le noyau visuel s'en sert pour reagir a la voix reelle plutot qu'a une
   * animation decorative. C'est ce qui fait la difference entre « ca bouge »
   * et « il m'ecoute ».
   */
  level(): number {
    if (!this.analyser || !this.samples) return 0;
    this.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i += 1) {
      const deviation = (this.samples[i] - 128) / 128;
      sum += deviation * deviation;
    }
    const rms = Math.sqrt(sum / this.samples.length);
    // La parole normale tourne autour de 0.05-0.25 en RMS: on etale cette
    // plage sur 0..1, sinon le noyau bougerait a peine.
    return Math.min(1, rms * 4.2);
  }

  get supported(): boolean {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices;
  }

  async start(): Promise<void> {
    if (!this.supported) throw new Error("Micro non supporte par ce navigateur.");
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    }
    this.attachAnalyser();
    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start();
  }

  async stop(): Promise<{ base64: string; mime: string } | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return null;
    const mime = recorder.mimeType;
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: mime }));
      recorder.stop();
    });
    this.recorder = null;
    if (blob.size < 1200) return null; // trop court: probablement un faux depart
    return { base64: await blobToBase64(blob), mime };
  }

  release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.analyser = null;
    this.samples = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  /** Branche l'analyseur sur le flux, une seule fois. */
  private attachAnalyser(): void {
    if (this.analyser || !this.stream) return;
    try {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      this.context = new AudioContextClass();
      const source = this.context.createMediaStreamSource(this.stream);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      this.analyser = analyser;
      this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    } catch {
      /* analyse indisponible: le noyau retombe sur son animation propre */
    }
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const VOICE_PREFERENCE_KEY = "jarvis.voice";

/** Classe les voix: ce qui sonne le mieux d'abord.
 *
 * Les voix « Natural » / « Online » de Microsoft sont d'une generation au-dessus
 * des voix locales historiques. Edge les expose sans rien installer; Chrome ne
 * les voit pas — d'ou l'ecart de qualite entre les deux navigateurs.
 */
function scoreVoice(voice: SpeechSynthesisVoice): number {
  let points = 0;
  if (/natural/i.test(voice.name)) points += 100;
  if (/neural|premium|enhanced|siri/i.test(voice.name)) points += 60;
  if (/online/i.test(voice.name)) points += 40;
  // Prenoms masculins des voix francaises courantes (Windows, macOS, Chrome).
  if (/antoine|thomas|nicolas|henri|claude|paul|jean|remy|daniel|guillaume/i.test(voice.name)) {
    points += 30;
  }
  // Francais canadien d'abord, puis francais de France.
  if (/fr[-_]ca/i.test(voice.lang)) points += 20;
  else if (/fr[-_]fr/i.test(voice.lang)) points += 10;
  if (voice.localService) points -= 5; // souvent les anciennes voix embarquees
  return points;
}

/** Lecture de la reponse: audio du serveur, ou voix du systeme en repli.
 *
 * Deux choix gouvernent la fluidite percue.
 *
 * 1. **Parler par phrase, pas par reponse.** Des qu'une phrase est complete
 *    dans le flux, elle est mise en file. L'assistant commence donc a parler
 *    pendant que la suite s'ecrit, au lieu d'attendre le point final.
 * 2. **Choisir la meilleure voix disponible.** Windows expose des voix
 *    « Natural » nettement superieures aux voix locales historiques, mais
 *    `speechSynthesis` ne les priorise pas. On le fait ici.
 */
export class SpeechPlayer {
  private queue: HTMLAudioElement[] = [];
  private current: HTMLAudioElement | null = null;
  private usingSystemVoice = false;
  private buffer = "";
  private voice: SpeechSynthesisVoice | null = null;
  private voiceResolved = false;

  // -- audio fourni par le serveur ------------------------------------------

  enqueueBase64(base64: string, mime: string): void {
    const audio = new Audio(`data:${mime};base64,${base64}`);
    audio.onended = () => this.playNext();
    this.queue.push(audio);
    if (!this.current) this.playNext();
  }

  // -- voix du systeme -------------------------------------------------------

  /** Prepare un nouveau tour de parole: coupe tout ce qui restait. */
  beginTurn(): void {
    this.buffer = "";
    this.stop();
  }

  /** Accumule le flux et prononce chaque phrase des qu'elle est complete. */
  pushStreamedText(chunk: string, language = "fr-CA"): void {
    if (!this.supportsSystemVoice()) return;
    this.buffer += chunk;

    // On ne parle qu'une phrase terminee: couper au milieu d'un mot
    // s'entendrait immediatement.
    const boundary = /[.!?…]["»)]?\s/;
    let match = boundary.exec(this.buffer);
    while (match) {
      const end = match.index + match[0].length;
      this.speakChunk(this.buffer.slice(0, end), language);
      this.buffer = this.buffer.slice(end);
      match = boundary.exec(this.buffer);
    }
  }

  /** Prononce ce qui reste a la fin du tour (derniere phrase sans ponctuation). */
  flushStreamedText(fullText: string, language = "fr-CA"): void {
    if (!this.supportsSystemVoice()) return;
    // Rien n'a ete diffuse en flux: on prononce la reponse entiere.
    if (!this.buffer && !this.usingSystemVoice) {
      this.speakChunk(fullText, language);
      return;
    }
    if (this.buffer.trim()) this.speakChunk(this.buffer, language);
    this.buffer = "";
  }

  /** Nom de la voix retenue, pour que l'utilisateur sache ce qu'il entend. */
  voiceName(): string {
    this.resolveVoice();
    return this.voice?.name ?? "voix par defaut";
  }

  /** Voix francaises disponibles, de la meilleure a la moins bonne. */
  availableVoices(): { name: string; lang: string; natural: boolean }[] {
    if (!this.supportsSystemVoice()) return [];
    return window.speechSynthesis
      .getVoices()
      .filter((v) => v.lang.toLowerCase().startsWith("fr"))
      .sort((a, b) => scoreVoice(b) - scoreVoice(a))
      .map((v) => ({
        name: v.name,
        lang: v.lang,
        natural: /natural|neural|online/i.test(v.name),
      }));
  }

  /** Impose une voix precise. Le choix de l'oreille prime sur mon classement. */
  setVoice(name: string): void {
    if (!this.supportsSystemVoice()) return;
    const found = window.speechSynthesis.getVoices().find((v) => v.name === name);
    if (!found) return;
    this.voice = found;
    this.voiceResolved = true;
    try {
      window.localStorage.setItem(VOICE_PREFERENCE_KEY, name);
    } catch {
      /* navigation privee: le choix vaut pour la session, sans plus */
    }
  }

  /** Fait entendre la voix immediatement, pour comparer sans lancer un tour. */
  preview(name: string, language = "fr-CA"): void {
    this.setVoice(name);
    this.stop();
    this.speakChunk("Bonsoir Greg. Tout est en place.", language);
  }

  stop(): void {
    this.current?.pause();
    this.current = null;
    this.queue = [];
    if (this.usingSystemVoice && this.supportsSystemVoice()) {
      window.speechSynthesis.cancel();
    }
  }

  private supportsSystemVoice(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  private speakChunk(text: string, language: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.usingSystemVoice = true;
    this.resolveVoice();

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = language;
    // Legerement au-dessus du naturel: pose, sans lenteur.
    utterance.rate = 1.06;
    utterance.pitch = 0.95;
    if (this.voice) utterance.voice = this.voice;
    // `speak` met en file: les phrases s'enchainent sans blanc.
    window.speechSynthesis.speak(utterance);
  }

  /** Retient la meilleure voix francaise, ou celle deja choisie par l'utilisateur. */
  private resolveVoice(): void {
    if (this.voiceResolved || !this.supportsSystemVoice()) return;
    const voices = window.speechSynthesis.getVoices();
    // La liste arrive de facon asynchrone: on retentera au prochain appel.
    if (voices.length === 0) return;

    let preferred: string | null = null;
    try {
      preferred = window.localStorage.getItem(VOICE_PREFERENCE_KEY);
    } catch {
      /* stockage indisponible: on retombe sur la selection automatique */
    }
    const chosen = preferred && voices.find((v) => v.name === preferred);
    if (chosen) {
      this.voice = chosen;
      this.voiceResolved = true;
      return;
    }

    const french = voices.filter((v) => v.lang.toLowerCase().startsWith("fr"));
    if (french.length === 0) return;
    this.voiceResolved = true;
    this.voice = french.reduce(
      (best, v) => (scoreVoice(v) > scoreVoice(best) ? v : best),
      french[0],
    );
  }

  private playNext(): void {
    const next = this.queue.shift();
    this.current = next ?? null;
    void next?.play().catch(() => undefined);
  }
}
