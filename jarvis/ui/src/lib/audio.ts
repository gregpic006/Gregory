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

  /** Selectionne la meilleure voix francaise disponible, une fois pour toutes. */
  private resolveVoice(): void {
    if (this.voiceResolved || !this.supportsSystemVoice()) return;
    const voices = window.speechSynthesis.getVoices();
    // La liste arrive de facon asynchrone: on retentera au prochain appel.
    if (voices.length === 0) return;
    this.voiceResolved = true;

    const french = voices.filter((v) => v.lang.toLowerCase().startsWith("fr"));
    if (french.length === 0) return;

    const score = (v: SpeechSynthesisVoice): number => {
      let points = 0;
      // Les voix « Natural » / « Online » de Windows sont d'une autre generation.
      if (/natural/i.test(v.name)) points += 100;
      if (/online/i.test(v.name)) points += 40;
      if (/neural|premium|enhanced|siri/i.test(v.name)) points += 60;
      // Prenoms masculins des voix francaises courantes (Windows, macOS, Chrome).
      if (/antoine|thomas|nicolas|henri|claude|paul|jean|remy|daniel|guillaume/i.test(v.name)) {
        points += 30;
      }
      // Francais canadien d'abord, puis francais de France.
      if (/fr[-_]ca/i.test(v.lang)) points += 20;
      else if (/fr[-_]fr/i.test(v.lang)) points += 10;
      if (v.localService) points -= 5; // souvent les anciennes voix embarquees
      return points;
    };

    this.voice = french.reduce((best, v) => (score(v) > score(best) ? v : best), french[0]);
  }

  private playNext(): void {
    const next = this.queue.shift();
    this.current = next ?? null;
    void next?.play().catch(() => undefined);
  }
}
