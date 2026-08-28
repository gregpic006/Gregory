import { useCallback, useEffect, useState } from "react";

import { Card } from "./Card";
import { IconBuilding } from "./layout/icons";
import {
  addFolderSource,
  discoverFolders,
  fetchFolderSources,
  removeFolderSource,
  scanFoldersNow,
  type DiscoveryReport,
  type FolderCandidate,
  type FolderScanReport,
  type FolderSource,
} from "../lib/api";
import type { BusinessOrg } from "../lib/types";

/**
 * Pointer directement le dossier d'export d'une caisse.
 *
 * C'est la meilleure voie quand elle est disponible: pas de courriel a
 * configurer, pas de fournisseur a solliciter, et les chiffres arrivent des
 * que la caisse ecrit son rapport.
 *
 * Le chemin peut etre un partage reseau (`\\\\SERVEUR\\Rapports`). Aucun mot de
 * passe n'est demande ici et aucun ne doit l'etre: c'est Windows qui detient
 * l'acces au partage, JARVIS ne fait que lire un chemin.
 *
 * **JARVIS ne modifie rien dans ce dossier.** Il lit; il ne deplace, ne
 * renomme et n'efface aucun fichier — un dossier de caisse est un dossier de
 * production.
 */

interface Props {
  organizations: BusinessOrg[];
}

export function FolderSources({ organizations }: Props) {
  const [sources, setSources] = useState<FolderSource[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [path, setPath] = useState("");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [report, setReport] = useState<FolderScanReport | null>(null);
  const [found, setFound] = useState<DiscoveryReport | null>(null);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(() => {
    fetchFolderSources()
      .then((data) => setSources(data.sources))
      .catch(() => setSources([]));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (!orgId && organizations.length > 0) setOrgId(organizations[0].id);
  }, [orgId, organizations]);

  const add = async () => {
    setBusy(true);
    setNote("");
    try {
      const result = await addFolderSource({
        org_id: orgId,
        path: path.trim(),
        pattern: pattern.trim(),
      });
      // Le chemin est verifie tout de suite: une faute de frappe se decouvre
      // ici, pas des heures plus tard devant un tableau de bord vide.
      setNote(result.warning || "Dossier lisible. Les rapports seront importes.");
      setPath("");
      setPattern("");
      setAdding(false);
      refresh();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Ajout impossible.");
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true);
    setNote("");
    setReport(null);
    try {
      setReport(await scanFoldersNow());
      refresh();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Lecture impossible.");
    } finally {
      setBusy(false);
    }
  };

  /** Cherche les dossiers de rapports au lieu de demander un chemin. */
  const search = async () => {
    setSearching(true);
    setNote("");
    setFound(null);
    try {
      setFound(await discoverFolders());
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Recherche impossible.");
    } finally {
      setSearching(false);
    }
  };

  /** Branche un dossier propose, sans rien faire retaper. */
  const accept = async (candidate: FolderCandidate) => {
    setBusy(true);
    try {
      await addFolderSource({ org_id: orgId, path: candidate.path });
      setFound((current) =>
        current
          ? { ...current, candidates: current.candidates.filter((c) => c.path !== candidate.path) }
          : current,
      );
      setNote(`Dossier branche sur ${nameOf(orgId)}.`);
      refresh();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Ajout impossible.");
    } finally {
      setBusy(false);
    }
  };

  const drop = async (source: FolderSource) => {
    await removeFolderSource(source.id).catch(() => undefined);
    refresh();
  };

  const nameOf = (id: string) => organizations.find((o) => o.id === id)?.name ?? id;

  return (
    <Card
      title="Dossier de la caisse"
      icon={<IconBuilding size={14} />}
      count={sources?.length ? String(sources.length) : ""}
    >
      <div className="stack">
        <p className="card-empty">
          Si tu vois le serveur de ta caisse depuis cet ordinateur, donne-moi le
          dossier ou elle depose ses rapports. J'y lis les CSV a mesure qu'ils
          arrivent. <b>Je ne touche a rien</b>: aucun fichier deplace, renomme ou
          efface. <b>Aucun mot de passe</b> non plus — c'est Windows qui detient
          l'acces au partage.
        </p>

        {sources === null ? (
          <p className="card-empty">Chargement…</p>
        ) : sources.length === 0 ? (
          <p className="card-empty">Aucun dossier configure.</p>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {sources.map((source) => (
              <div key={source.id} style={{ display: "flex", gap: 8, fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ wordBreak: "break-all" }}>{source.path}</b>
                  <span className="card-empty"> → {nameOf(source.org_id)}</span>
                  {source.pattern && (
                    <span className="card-empty"> · {source.pattern}</span>
                  )}
                  {source.last_error && (
                    <span className="card-empty"> · ⚠ {source.last_error}</span>
                  )}
                </span>
                <button className="btn small" onClick={() => drop(source)}>
                  Retirer
                </button>
              </div>
            ))}
          </div>
        )}

        {adding ? (
          <div className="stack">
            <select
              className="input"
              value={orgId}
              onChange={(event) => setOrgId(event.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              placeholder={"Chemin du dossier (ex: \\\\SERVEUR-MD\\Rapports)"}
              value={path}
              autoFocus
              onChange={(event) => setPath(event.target.value)}
            />
            <input
              className="input"
              style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              placeholder="Ne prendre que (optionnel, ex: ventes*.csv)"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn primary small"
                onClick={add}
                disabled={busy || path.trim().length < 2 || !orgId}
              >
                Ajouter
              </button>
              <button className="btn small" onClick={() => setAdding(false)}>
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn primary small"
              onClick={search}
              disabled={searching || organizations.length === 0}
            >
              {searching ? "Recherche en cours…" : "Trouve-les pour moi"}
            </button>
            <button
              className="btn small"
              onClick={() => setAdding(true)}
              disabled={organizations.length === 0}
            >
              + Chemin manuel
            </button>
            {sources !== null && sources.length > 0 && (
              <button className="btn small" onClick={scan} disabled={busy}>
                {busy ? "Lecture…" : "Lire maintenant"}
              </button>
            )}
          </div>
        )}

        {found && (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13 }}>{found.summary}</p>
            {found.candidates.map((candidate) => (
              <div
                key={candidate.path}
                className="stack"
                style={{
                  gap: 4,
                  padding: "8px 10px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <b style={{ fontSize: 13, wordBreak: "break-all" }}>{candidate.path}</b>
                <span className="card-empty">
                  {candidate.files} fichier(s) · plus recent {candidate.newest || "?"} ·
                  je lirai : {candidate.columns.join(", ")}
                </span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    className="input"
                    style={{ flex: 1, minWidth: 0 }}
                    value={orgId}
                    onChange={(event) => setOrgId(event.target.value)}
                  >
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn primary small"
                    onClick={() => accept(candidate)}
                    disabled={busy}
                  >
                    Brancher
                  </button>
                </div>
              </div>
            ))}
            {found.truncated && found.candidates.length === 0 && (
              <p className="card-empty">
                La recherche s'est arretee avant d'avoir tout vu. Utilise le chemin
                manuel si tu le connais.
              </p>
            )}
          </div>
        )}

        {note && <p className="card-empty">{note}</p>}

        {report && (
          <div className="stack" style={{ gap: 4 }}>
            <p style={{ margin: 0, fontSize: 13 }}>{report.summary}</p>
            {report.imported.map((name) => (
              <span className="card-empty" key={name}>
                · {name}
              </span>
            ))}
            {report.failed.map((item) => (
              <span className="card-empty" key={item.name}>
                · {item.name} — {item.reason}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
