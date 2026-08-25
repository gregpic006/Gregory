import { useEffect, useRef } from "react";

import { IconAlert, IconCheck } from "./layout/icons";
import type { AlertsState } from "../lib/useAlerts";

const KIND_LABELS: Record<string, string> = {
  calendar: "Agenda",
  reminder: "Rappel",
  business: "Entreprises",
  email: "Courriels",
};

/** Panneau des alertes.
 *
 * « Aucune alerte » et « surveillance eteinte » sont deux messages distincts:
 * le premier veut dire que JARVIS a regarde et n'a rien vu, le second qu'il
 * n'a pas regarde du tout.
 */
export function AlertPanel({ state, onClose }: { state: AlertsState; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Differe d'un tour: le clic qui ouvre le panneau ne doit pas le refermer.
    const timer = window.setTimeout(() => document.addEventListener("mousedown", away), 0);
    document.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  return (
    <div className="alert-panel" ref={panel}>
      <div className="alert-head">
        <span className="metric-label">Alertes</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn small"
          onClick={state.toggleNotifications}
          disabled={state.notificationsBlocked}
          title={
            state.notificationsBlocked
              ? "Ton navigateur bloque les notifications pour ce site"
              : "Recevoir une notification Windows"
          }
        >
          {state.notificationsOn ? "Notifications actives" : "Activer les notifications"}
        </button>
      </div>

      {state.notificationsBlocked && (
        <p className="alert-empty">
          Les notifications sont bloquees pour ce site. Clique sur le cadenas a gauche de
          l'adresse, puis autorise les notifications.
        </p>
      )}

      {!state.enabled ? (
        <p className="alert-empty">
          La surveillance est desactivee. Active-la dans Reglages pour que JARVIS te
          previenne d'une reunion imminente ou d'un rappel echu.
        </p>
      ) : state.alerts.length === 0 ? (
        <p className="alert-empty">
          Rien a signaler. J'ai regarde — c'est different de « je n'ai pas regarde ».
        </p>
      ) : (
        <div className="alert-list">
          {state.alerts.map((alert) => (
            <div className={`alert-item ${alert.severity}`} key={alert.id}>
              <div className="alert-item-head">
                <span className="metric-label">{KIND_LABELS[alert.kind] ?? alert.kind}</span>
                <span style={{ flex: 1 }} />
                <button
                  className="alert-dismiss"
                  onClick={() => state.dismiss(alert.id)}
                  title="Marquer comme vu"
                >
                  <IconCheck size={13} />
                </button>
              </div>
              <p className="alert-title">{alert.title}</p>
              {alert.detail && <p className="alert-detail">{alert.detail}</p>}
              <span className="alert-source">{alert.source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Cloche du haut de page, avec le nombre d'alertes non vues. */
export function AlertBell({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="icon-btn alert-bell" onClick={onClick} title="Alertes">
      <IconAlert size={17} />
      {count > 0 && <span className="alert-badge">{count > 9 ? "9+" : count}</span>}
    </button>
  );
}
