import { useCallback, useEffect, useRef, useState } from "react";

import { Card } from "../components/Card";
import { IconBuilding, IconRefresh } from "../components/layout/icons";
import {
  archiveOrganization,
  createOrganization,
  fetchBusinesses,
  importBusinessCsv,
  ORG_KINDS,
  renameOrganization,
  type BusinessImportReport,
  type BusinessesResponse,
} from "../lib/api";
import type { BusinessMetric } from "../lib/types";

/** Modele CSV par type: l'utilisateur ouvre le fichier, remplace les chiffres. */
const TEMPLATES: Record<string, string> = {
  restaurant: "/modele-restaurant.csv",
  saas: "/modele-saas.csv",
  realestate: "/modele-immobilier.csv",
};

const PERIODS = [
  { days: 7, label: "7 jours" },
  { days: 30, label: "30 jours" },
  { days: 90, label: "90 jours" },
];

/** Une ligne d'indicateur.
 *
 * Trois etats visuellement distincts, parce qu'ils appellent trois reactions
 * differentes: une valeur sure, une valeur perimee, et pas de valeur du tout.
 * Une couverture partielle est ecrite a cote du chiffre — « 27 731,50 $ » sur
 * 4 jours ne veut pas dire la meme chose que sur 7.
 */
function MetricRow({ metric }: { metric: BusinessMetric }) {
  if (metric.value === null || metric.status === "not_connected") {
    return (
      <div className="field">
        <span className="k">{metric.label}</span>
        <span className="v off">non connecte</span>
      </div>
    );
  }

  return (
    <div className="metric-row">
      <div className="field">
        <span className="k">{metric.label}</span>
        <span className="v" style={metric.status === "stale" ? { color: "var(--warn)" } : {}}>
          {metric.display}
        </span>
      </div>
      {metric.status === "stale" && (
        <span className="metric-note warn">{metric.detail}</span>
      )}
      {metric.status === "connected" && !metric.complete && (
        <span className="metric-note">
          {metric.days_covered} jour(s) sur {metric.days_requested} — total partiel
        </span>
      )}
    </div>
  );
}

/** Centre de commande business.
 *
 * Aucun chiffre n'est affiche tant qu'il ne vient pas d'une source reelle. Un
 * indicateur sans donnee dit « non connecte » plutot que zero: la difference
 * entre « aucune vente » et « je ne sais pas » est celle sur laquelle une
 * decision se prend.
 */
export function BusinessesView() {
  const [data, setData] = useState<BusinessesResponse | null>(null);
  const [days, setDays] = useState(7);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ org: string; report: BusinessImportReport } | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("restaurant");

  const load = useCallback(() => {
    fetchBusinesses(days)
      .then((payload) => {
        setData(payload);
        setError("");
      })
      .catch(() => setError("Impossible de charger les entreprises."));
  }, [days]);

  useEffect(load, [load]);

  const add = async () => {
    if (!newName.trim()) return;
    try {
      await createOrganization(newName.trim(), newKind);
      setNewName("");
      setAdding(false);
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creation impossible.");
    }
  };

  const rename = async (id: string, current: string, kind: string) => {
    const next = window.prompt("Nouveau nom de l'entreprise", current);
    if (!next || next.trim() === current) return;
    try {
      await renameOrganization(id, next.trim(), kind);
      load();
    } catch {
      setError("Renommage impossible.");
    }
  };

  const archive = async (id: string, name: string) => {
    // Archivage, pas suppression: les chiffres sont conserves. On le dit dans
    // la question, sinon l'utilisateur hesitera a cliquer.
    if (!window.confirm(`Retirer « ${name} » de la liste ?\n\nSes chiffres sont conserves et l'entreprise peut etre restauree.`)) {
      return;
    }
    try {
      await archiveOrganization(id);
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Retrait impossible.");
    }
  };

  const upload = async (orgId: string, orgName: string, file: File) => {
    setBusy(orgId);
    setError("");
    try {
      setReport({ org: orgName, report: await importBusinessCsv(orgId, file) });
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import impossible.");
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="dash-head">
        <h1>Entreprises</h1>
        <p>
          {data?.period.start
            ? `Du ${data.period.start} au ${data.period.end}.`
            : "Une organisation, un contexte, ses propres sources de donnees."}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PERIODS.map((period) => (
            <button
              className={`btn small${days === period.days ? " primary" : ""}`}
              onClick={() => setDays(period.days)}
              key={period.days}
            >
              {period.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={() => setAdding((v) => !v)}>
            {adding ? "Annuler" : "+ Ajouter une entreprise"}
          </button>
        </div>
      </div>

      {adding && (
        <Card title="Nouvelle entreprise" icon={<IconBuilding size={14} />}>
          <div className="stack">
            <input
              className="input"
              style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              placeholder="Nom de l'entreprise"
              value={newName}
              autoFocus
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && add()}
            />
            <select
              className="input"
              value={newKind}
              onChange={(event) => setNewKind(event.target.value)}
            >
              {ORG_KINDS.map((kind) => (
                <option value={kind.value} key={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
            <p className="card-empty">
              Le type determine les indicateurs proposes: ventes et couverts pour un
              restaurant, revenus recurrents pour un logiciel, occupation et loyers
              pour de l'immobilier.
            </p>
            <button className="btn primary" onClick={add} disabled={!newName.trim()}>
              Ajouter
            </button>
          </div>
        </Card>
      )}

      {data && !data.enabled && <p className="section-note">{data.note}</p>}
      {error && <div className="banner">{error}</div>}

      {report && (
        <Card title={`Import — ${report.org}`} icon={<IconRefresh />}>
          <div className="stack">
            <p style={{ margin: 0, fontSize: 13.5 }}>{report.report.summary}</p>
            {report.report.ignored_columns.length > 0 && (
              <div className="field">
                <span className="k">colonnes ignorees</span>
                <span className="v">{report.report.ignored_columns.join(", ")}</span>
              </div>
            )}
            {report.report.errors.map((item) => (
              <div className="field" key={item.line}>
                <span className="k">ligne {item.line} refusee</span>
                <span className="v">{item.reason}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid">
        {(data?.organizations ?? []).map((org) => {
          const live = org.metrics.filter((m) => m.value !== null).length;
          return (
            <Card
              title={org.name}
              icon={<IconBuilding size={14} />}
              count={live || ""}
              key={org.id}
            >
              <div className="stack">
                {org.metrics.length === 0 ? (
                  <span className="not-connected">non connecte</span>
                ) : (
                  org.metrics.map((metric) => (
                    <MetricRow metric={metric} key={metric.metric} />
                  ))
                )}

                {data?.enabled && (
                  <div className="card-footer">
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {org.latest_day
                        ? `derniere donnee ${org.latest_day}`
                        : "aucune donnee importee"}
                    </span>
                    <span style={{ flex: 1 }} />
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      style={{ display: "none" }}
                      ref={(element) => {
                        inputs.current[org.id] = element;
                      }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) upload(org.id, org.name, file);
                        event.target.value = "";
                      }}
                    />
                    <button
                      className="btn small"
                      disabled={busy === org.id}
                      onClick={() => inputs.current[org.id]?.click()}
                      title="Importer un export CSV de ta caisse"
                    >
                      {busy === org.id ? "Import…" : "Importer un CSV"}
                    </button>
                    {TEMPLATES[org.kind] && (
                      <a
                        className="btn small"
                        href={TEMPLATES[org.kind]}
                        download
                        title="Telecharger un fichier d'exemple a remplir"
                      >
                        Modele CSV
                      </a>
                    )}
                    <button
                      className="btn small"
                      onClick={() => rename(org.id, org.name, org.kind)}
                      title="Renommer"
                    >
                      Renommer
                    </button>
                    <button
                      className="btn small"
                      onClick={() => archive(org.id, org.name)}
                      title="Retirer de la liste (les chiffres sont conserves)"
                    >
                      Retirer
                    </button>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
