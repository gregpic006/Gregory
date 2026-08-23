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

/** File d'attente de lecture audio, pour enchainer les phrases sans blanc. */
export class SpeechPlayer {
  private queue: HTMLAudioElement[] = [];
  private current: HTMLAudioElement | null = null;
  private usingSystemVoice = false;

  enqueueBase64(base64: string, mime: string): void {
    const audio = new Audio(`data:${mime};base64,${base64}`);
    audio.onended = () => this.playNext();
    this.queue.push(audio);
    if (!this.current) this.playNext();
  }

  /** Repli quand aucun moteur TTS serveur n'est configure. */
  speakWithSystemVoice(text: string, language = "fr-CA"): void {
    if (!("speechSynthesis" in window) || !text.trim()) return;
    this.usingSystemVoice = true;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    utterance.rate = 1.05;
    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => v.lang.startsWith("fr") && /male|homme|thomas|nicolas/i.test(v.name)) ??
      voices.find((v) => v.lang.startsWith(language.slice(0, 2)));
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    this.current?.pause();
    this.current = null;
    this.queue = [];
    if (this.usingSystemVoice && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  private playNext(): void {
    const next = this.queue.shift();
    this.current = next ?? null;
    void next?.play().catch(() => undefined);
  }
}
