import { useState } from "react";

import { Card } from "../components/Card";
import { IconPlug } from "../components/layout/icons";
import { connectGoogle, disconnectGoogle } from "../lib/api";
import type { SystemInfo, ViewId } from "../lib/types";

interface Props {
  system: SystemInfo | null;
  onChanged: () => void;
  onNavigate: (view: ViewId) => void;
}

/** Ce qu'on peut dire d'une integration.
 *
 * Trois etats, et jamais de jalon a la place: annoncer « prevu M4 » quand M4
 * est livre laisse croire qu'une chose arrive alors qu'elle a ete tranchee.
 * Surtout, ca cache a l'utilisateur la voie qui, elle, fonctionne deja.
 */
type Availability =
  | { kind: "ready"; note: string }
  | { kind: "workaround"; note: string; action: string }
  | { kind: "absent"; note: string };

interface Service {
  name: string;
  detail: string;
  availability: Availability;
}

/** Systemes sans connecteur direct, et ce qui marche a la place. */
const SERVICES: Service[] = [
  {
    name: "Maitre'D / PayFacto",
    detail: "Ventes, couverts et pourboires des restaurants",
    availability: {
      kind: "workaround",
      note:
        "Aucun connecteur direct. Tes chiffres entrent quand meme: colle-les " +
        "depuis un rapport, ou fais deposer un export dans le dossier surveille.",
      action: "Voir Entreprises",
    },
  },
  {
    name: "7Shifts",
    detail: "Horaires et masse salariale",
    availability: {
      kind: "workaround",
      note:
        "Aucun connecteur direct. La masse salariale s'importe comme le reste, " +
        "par collage ou par fichier.",
      action: "Voir Entreprises",
    },
  },
  {
    name: "OpenTable",
    detail: "Reservations",
    availability: {
      kind: "workaround",
      note:
        "Aucun connecteur direct. La colonne « Reservations » d'un import est " +
        "reconnue si tu l'ajoutes a tes chiffres.",
      action: "Voir Entreprises",
    },
  },
  {
    name: "Stripe",
    detail: "Revenus recurrents et abonnements",
    availability: {
      kind: "absent",
      note:
        "Pas construit. A faire quand la facturation de Portail sera en place — " +
        "d'ici la, le MRR s'importe a la main.",
    },
  },
  {
    name: "Recherche web",
    detail: "Informations externes et recentes",
    availability: { kind: "absent", note: "Pas construit." },
  },
];

function AvailabilityLine({
  availability,
  onNavigate,
}: {
  availability: Availability;
  onNavigate: (view: ViewId) => void;
}) {
  if (availability.kind === "ready") {
    return (
      <>
        <span className="not-connected" style={{ color: "var(--accent)" }}>
          disponible
        </span>
        <span className="card-empty">{availability.note}</span>
      </>
    );
  }
  if (availability.kind === "workaround") {
    return (
      <>
        <span className="not-connected" style={{ color: "var(--warn)" }}>
          autrement
        </span>
        <span className="card-empty">{availability.note}</span>
        <button
          className="btn small"
          style={{ alignSelf: "flex-start", marginTop: 4 }}
          onClick={() => onNavigate("businesses")}
        >
          {availability.action}
        </button>
      </>
    );
  }
  return (
    <>
      <span className="not-connected">non construit</span>
      <span className="card-empty">{availability.note}</span>
    </>
  );
}

/** Page Integrations: ce qui est branche, et pour le reste, ce qui marche quand meme. */
export function IntegrationsView({ system, onChanged, onNavigate }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const google = system?.integrations?.google ?? null;
  const driveEnabled = Boolean(google?.features?.drive);
  const driveGranted = Boolean(
    google?.scopes?.some((scope) => scope.includes("drive.readonly")),
  );

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
        <p>Ce qui est branche, et pour le reste, comment faire entrer tes donnees.</p>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="grid">
        <Card
          title="Google Workspace"
          icon={<IconPlug size={14} />}
          count={
            google?.connected ? "connecte" : google?.configured ? "a connecter" : "non configure"
          }
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
                  Active Gmail ou Calendrier dans Reglages, sinon aucune permission
                  utile ne serait demandee.
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

        {/* Drive est construit: son etat se lit, il ne s'annonce pas. */}
        <Card
          title="Google Drive"
          icon={<IconPlug size={14} />}
          count={driveEnabled && driveGranted ? "connecte" : ""}
        >
          <div className="stack">
            {driveEnabled && driveGranted ? (
              <>
                <span className="not-connected" style={{ color: "var(--ok)" }}>
                  connecte
                </span>
                <span className="card-empty">
                  Le dossier configure est indexe. Lance « jarvis sync-drive » pour
                  le mettre a jour.
                </span>
              </>
            ) : driveEnabled ? (
              <>
                <span className="not-connected" style={{ color: "var(--warn)" }}>
                  reconnexion requise
                </span>
                <span className="card-empty">
                  Drive est active mais la permission n'a pas ete accordee.
                  Deconnecte puis reconnecte Google ci-contre.
                </span>
              </>
            ) : (
              <>
                <span className="not-connected" style={{ color: "var(--accent)" }}>
                  disponible
                </span>
                <span className="card-empty">
                  Indexation d'un dossier Drive, prete a l'emploi. Coche « Google Drive »
                  dans Reglages, puis reconnecte ton compte Google — la permission est
                  demandee a ce moment-la.
                </span>
                <button
                  className="btn small"
                  style={{ alignSelf: "flex-start", marginTop: 4 }}
                  onClick={() => onNavigate("settings")}
                >
                  Ouvrir les Reglages
                </button>
              </>
            )}
          </div>
        </Card>

        {SERVICES.map((service) => (
          <Card title={service.name} icon={<IconPlug size={14} />} key={service.name}>
            <div className="stack">
              <AvailabilityLine availability={service.availability} onNavigate={onNavigate} />
              <span className="metric-label" style={{ marginTop: 4 }}>
                {service.detail}
              </span>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
