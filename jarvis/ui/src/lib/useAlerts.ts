/**
 * Surveillance proactive cote interface.
 *
 * Deux precautions rendent cette fonctionnalite supportable au quotidien.
 *
 * On ne demande la permission de notifier **qu'au moment ou l'utilisateur
 * l'active**, jamais au chargement de la page: une demande surgie de nulle
 * part se refuse par reflexe, et le refus est definitif.
 *
 * Une alerte deja affichee n'est jamais renotifiee. Le serveur deduplique
 * deja, mais un rechargement de page relit la meme liste — c'est ici qu'on
 * evite la double sonnerie.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAlerts, markAlertSeen, type JarvisAlert, type ScheduledJob } from "./api";

/** Le serveur surveille toutes les 5 minutes; ce rythme suffit a l'affichage. */
const POLL_MS = 60_000;
const STORAGE_KEY = "jarvis.notifications";

function notificationsAllowed(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    // Navigation privee, stockage bloque: on retombe sur « desactive ».
    return false;
  }
}

export interface AlertsState {
  alerts: JarvisAlert[];
  unseen: number;
  enabled: boolean;
  schedule: ScheduledJob[];
  notificationsOn: boolean;
  /** Vrai si le navigateur a refuse definitivement les notifications. */
  notificationsBlocked: boolean;
  toggleNotifications: () => Promise<void>;
  dismiss: (id: string) => void;
  refresh: () => void;
}

export function useAlerts(): AlertsState {
  const [alerts, setAlerts] = useState<JarvisAlert[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [schedule, setSchedule] = useState<ScheduledJob[]>([]);
  const [notificationsOn, setNotificationsOn] = useState(
    () => readPreference() && notificationsAllowed(),
  );
  const [notificationsBlocked, setBlocked] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "denied",
  );

  // Alertes deja poussees au systeme: elles ne doivent pas resonner deux fois.
  const notified = useRef<Set<string>>(new Set());
  const wantsNotifications = useRef(notificationsOn);
  wantsNotifications.current = notificationsOn;

  const refresh = useCallback(() => {
    fetchAlerts()
      .then((payload) => {
        setEnabled(payload.enabled);
        setSchedule(payload.schedule);
        setAlerts(payload.alerts);

        if (!wantsNotifications.current || !notificationsAllowed()) return;
        for (const alert of payload.alerts) {
          if (alert.seen || notified.current.has(alert.id)) continue;
          notified.current.add(alert.id);
          try {
            new Notification(alert.title, {
              body: alert.detail || alert.source,
              tag: alert.id,
              icon: "/favicon.svg",
            });
            void markAlertSeen(alert.id);
          } catch {
            // Certaines plateformes refusent l'appel direct; l'alerte reste
            // visible dans l'interface, ce qui est l'essentiel.
          }
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const toggleNotifications = useCallback(async () => {
    if (notificationsOn) {
      setNotificationsOn(false);
      try {
        localStorage.setItem(STORAGE_KEY, "off");
      } catch {
        /* stockage indisponible: le reglage vaut pour cette session */
      }
      return;
    }
    if (typeof Notification === "undefined") return;

    // La permission n'est demandee qu'ici, sur un geste explicite.
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") {
      setBlocked(permission === "denied");
      return;
    }
    setBlocked(false);
    setNotificationsOn(true);
    try {
      localStorage.setItem(STORAGE_KEY, "on");
    } catch {
      /* idem */
    }
    // Les alertes deja a l'ecran ne sonnent pas retroactivement.
    for (const alert of alerts) notified.current.add(alert.id);
  }, [alerts, notificationsOn]);

  const dismiss = useCallback((id: string) => {
    setAlerts((current) => current.filter((alert) => alert.id !== id));
    void markAlertSeen(id);
  }, []);

  return {
    alerts,
    unseen: alerts.filter((alert) => !alert.seen).length,
    enabled,
    schedule,
    notificationsOn,
    notificationsBlocked,
    toggleNotifications,
    dismiss,
    refresh,
  };
}
