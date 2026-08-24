import { useState } from "react";

import { Card } from "../components/Card";
import { IconPlug } from "../components/layout/icons";
import { connectGoogle, disconnectGoogle } from "../lib/api";
import type { SystemInfo } from "../lib/types";

interface Props {
  system: SystemInfo | null;
  onChanged: () => void;
}

/** Integrations a venir, avec leur jalon. On annonce, on ne simule pas. */
const PLANNED = [
  { name: "Google Drive", detail: "Documents et recherche semantique", milestone: "M3" },
  { name: "Stripe", detail: "Revenus et abonnements", milestone: "M4" },
  { name: "7Shifts", detail: "Horaires et masse salariale", milestone: "M4" },
  { name: "OpenTable", detail: "Reservations", milestone: "M4" },
  { name: "Maitre'D / PayFacto", detail: "Ventes des restaurants", milestone: "M4" },
  { name: "Recherche web", detail: "Informations externes et recentes", milestone: "M4" },
];

/** Page Integrations: connecter un service en un clic, quand c'est possible. */
export function IntegrationsView({ system, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const google = system?.integrations?.google ?? null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      window.setTimeout(onChanged, 1400);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Echec de l'operation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dash-head">
        <h1>Integrations</h1>
        <p>Ce qui est branche, et ce qui ne l'est pas encore.</p>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="grid">
        <Card
          title="Google Workspace"
          icon={<IconPlug size={14} />}
          count={google?.connected ? "connecte" : google?.configured ? "a connecter" : "non configure"}
        >
          <div className="stack">
            {google?.connected && google.account && (
              <div className="field">
                <span className="k">compte</span>
                <span className="v on">{google.account}</span>
              </div>
            )}

            {google?.connected && google.scopes && (
              <>
                <span className="metric-label">Permissions accordees</span>
                <div className="pill-row">
                  {google.scopes
                    .filter((scope) => scope.startsWith("https://"))
                    .map((scope) => (
                      <span className="tool-pill" key={scope} title={scope}>
                        {scope.replace("https://www.googleapis.com/auth/", "")}
                      </span>
                    ))}
                </div>
              </>
            )}

            {!google?.configured && (
              <p className="card-empty">
                Renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env.
                La marche a suivre complete est dans docs/google-setup.md.
              </p>
            )}

            {google?.configured &&
              !google.connected &&
              !google.features.gmail &&
              !google.features.calendar && (
                <p className="card-empty">
                  Active JARVIS_FEATURE_GMAIL ou JARVIS_FEATURE_CALENDAR dans .env,
                  sinon aucune permission utile ne serait demandee.
                </p>
              )}

            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {google?.connected ? (
                <button className="btn small" disabled={busy} onClick={() => run(disconnectGoogle)}>
                  Deconnecter
                </button>
              ) : (
                <button
                  className="btn accent small"
                  disabled={busy || !google?.configured}
                  onClick={() => run(connectGoogle)}
                >
                  {busy ? "…" : "Connecter Google"}
                </button>
              )}
            </div>
          </div>
        </Card>

        {PLANNED.map((service) => (
          <Card title={service.name} icon={<IconPlug size={14} />} key={service.name}>
            <div className="stack">
              <span className="not-connected">prevu {service.milestone}</span>
              <span className="card-empty">{service.detail}</span>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
