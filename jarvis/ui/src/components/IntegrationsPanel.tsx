import { useState } from "react";

import { connectGoogle, disconnectGoogle } from "../lib/api";
import type { GoogleStatus } from "../lib/types";

interface Props {
  google: GoogleStatus | null;
  onChanged: () => void;
}

/** Etat des integrations et connexion en un clic.
 *
 * Le consentement se fait chez Google, dans un onglet separe: JARVIS ne voit
 * jamais le mot de passe. On affiche les permissions reellement accordees,
 * pour que la portee de l'acces reste verifiable d'un coup d'oeil.
 */
export function IntegrationsPanel({ google, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!google) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      window.setTimeout(onChanged, 1200);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Echec");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Integrations</h2>

      <div className="integration">
        <div className="integration-head">
          <span className="integration-name">Google Workspace</span>
          <span className={`badge ${google.connected ? "on" : "off"}`}>
            {google.connected ? "connecte" : google.configured ? "a connecter" : "non configure"}
          </span>
        </div>

        {google.connected && google.account && (
          <div className="integration-detail">{google.account}</div>
        )}

        {google.connected && google.scopes && (
          <div className="scope-list">
            {google.scopes
              .filter((scope) => scope.startsWith("https://"))
              .map((scope) => (
                <span className="scope" key={scope} title={scope}>
                  {scope.replace("https://www.googleapis.com/auth/", "")}
                </span>
              ))}
          </div>
        )}

        {!google.configured && (
          <div className="integration-detail">
            Renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env
            (voir docs/google-setup.md).
          </div>
        )}

        {google.configured && !google.connected && !google.features.gmail && !google.features.calendar && (
          <div className="integration-detail">
            Active JARVIS_FEATURE_GMAIL ou JARVIS_FEATURE_CALENDAR dans .env.
          </div>
        )}

        {error && <div className="integration-error">{error}</div>}

        <div className="integration-actions">
          {google.connected ? (
            <button
              className="btn ghost small"
              disabled={busy}
              onClick={() => run(disconnectGoogle)}
            >
              Deconnecter
            </button>
          ) : (
            <button
              className="btn small"
              disabled={busy || !google.configured}
              onClick={() => run(connectGoogle)}
            >
              {busy ? "…" : "Connecter Google"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
