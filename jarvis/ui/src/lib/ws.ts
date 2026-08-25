/** Connexion temps reel a JARVIS.
 *
 * Reconnexion automatique avec recul exponentiel: une coupure reseau ne doit
 * pas obliger a recharger l'application.
 */

import { withToken } from "./session";

import type { ServerEvent } from "./types";

type Listener = (event: ServerEvent) => void;

export class JarvisSocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private closedByUser = false;
  private queue: string[] = [];

  constructor(private readonly sessionId?: string) {}

  connect(): void {
    this.closedByUser = false;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const suffix = this.sessionId ? `?session_id=${encodeURIComponent(this.sessionId)}` : "";
    // Un WebSocket ne peut pas porter d'en-tete: le jeton passe par l'URL.
    const url = withToken(`${protocol}://${window.location.host}/ws${suffix}`);
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.retry = 0;
      while (this.queue.length > 0) {
        const payload = this.queue.shift();
        if (payload) this.socket?.send(payload);
      }
    };

    this.socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        this.listeners.forEach((listener) => listener(parsed));
      } catch {
        /* message illisible: on l'ignore plutot que de casser l'interface */
      }
    };

    this.socket.onclose = () => {
      if (this.closedByUser) return;
      const delay = Math.min(1000 * 2 ** this.retry, 15000);
      this.retry += 1;
      window.setTimeout(() => this.connect(), delay);
    };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    } else {
      this.queue.push(data);
    }
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.close();
  }
}
