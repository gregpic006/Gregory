import { useCallback, useEffect, useState } from "react";

import { Card } from "../components/Card";
import { IconDocument, IconRefresh, IconSearch, IconTrash } from "../components/layout/icons";
import {
  fetchDocuments,
  forgetDocument,
  reindexDocuments,
  type DocumentsResponse,
  type ReindexResponse,
} from "../lib/api";
import { relative } from "../lib/format";

/** Libelle lisible pour un mode de recherche. */
const MODE_LABELS: Record<string, string> = {
  lexical: "mots exacts",
  semantique: "sens",
};

function humanSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/** Les documents indexes, et ce que la recherche sait reellement faire.
 *
 * L'ecran annonce ses modes de recherche parce que la difference est reelle:
 * sans modele semantique charge, JARVIS compare des mots, pas des idees. Le
 * masquer laisserait croire a une comprehension qu'il n'a pas.
 */
export function DocumentsView() {
  const [data, setData] = useState<DocumentsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<ReindexResponse | null>(null);
  const [indexing, setIndexing] = useState(false);

  const load = useCallback(() => {
    fetchDocuments(query)
      .then((response) => {
        setData(response);
        setError("");
      })
      .catch(() => setError("Impossible de lire l'index documentaire."));
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(load, query ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const reindex = async () => {
    setIndexing(true);
    setError("");
    try {
      setReport(await reindexDocuments());
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Indexation impossible.");
    } finally {
      setIndexing(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await forgetDocument(id);
      load();
    } catch {
      setError("Suppression impossible.");
    }
  };

  if (data && !data.enabled) {
    return (
      <>
        <div className="dash-head">
          <h1>Documents</h1>
        </div>
        <p className="section-note">
          La recherche documentaire est desactivee. Mets{" "}
          <code>JARVIS_FEATURE_DOCUMENTS=true</code> dans le fichier <code>.env</code>,
          puis relance JARVIS.
        </p>
      </>
    );
  }

  const modes = data?.search_modes ?? [];
  const hits = data?.hits ?? [];

  return (
    <>
      <div className="dash-head">
        <h1>Documents</h1>
        <p>
          {data?.total ?? 0} document(s) indexe(s).{" "}
          {modes.length > 0 && (
            <>
              Recherche par{" "}
              <strong>{modes.map((m) => MODE_LABELS[m] ?? m).join(" et ")}</strong>.
            </>
          )}
        </p>
        <button className="btn primary" onClick={reindex} disabled={indexing}>
          <IconRefresh /> {indexing ? "Indexation…" : "Reindexer le dossier"}
        </button>
      </div>

      {modes.length === 1 && modes[0] === "lexical" && (
        <p className="section-note">
          Le modele semantique n'est pas charge : je cherche les mots exacts, pas le
          sens. Une question formulee autrement que le document peut ne rien ramener.
        </p>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 240, fontFamily: "var(--sans)", fontSize: 13 }}
          placeholder="Chercher dans le contenu des documents…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error && <div className="banner">{error}</div>}

      {report && (
        <Card title="Derniere indexation" icon={<IconRefresh />}>
          <div className="stack">
            <p style={{ margin: 0, fontSize: 13.5 }}>{report.summary}</p>
            {report.report.failed.map((item) => (
              <div className="field" key={item.name}>
                <span className="k">echec — {item.name}</span>
                <span className="v">{item.reason}</span>
              </div>
            ))}
            {report.report.skipped.map((item) => (
              <div className="field" key={item.name}>
                <span className="k">ignore — {item.name}</span>
                <span className="v">{item.reason}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {query && (
        <div className="grid" style={{ marginTop: 14 }}>
          {hits.length === 0 && (
            <Card title="Aucun passage" icon={<IconSearch size={14} />}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                Rien trouve pour « {query} » dans les {data?.total ?? 0} document(s)
                indexes. Cela veut dire que je n'ai rien trouve, pas que l'information
                n'existe pas.
              </p>
            </Card>
          )}
          {hits.map((hit) => (
            <Card
              title={hit.locator ? `${hit.title} — ${hit.locator}` : hit.title}
              icon={<IconSearch size={14} />}
              key={`${hit.document_id}-${hit.locator}-${hit.text.slice(0, 24)}`}
            >
              <div className="stack">
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                  {hit.text.slice(0, 420)}
                  {hit.text.length > 420 ? "…" : ""}
                </p>
                <div className="field">
                  <span className="k">trouve par</span>
                  <span className="v">
                    {hit.matched_by.map((m) => MODE_LABELS[m] ?? m).join(" + ")}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {!query && (
        <div className="grid">
          {(data?.documents ?? []).length === 0 && (
            <Card title="Index vide" icon={<IconDocument size={14} />}>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
                Aucun document indexe. Depose des fichiers (.pdf, .docx, .md, .txt)
                dans <code>{data?.documents_dir ?? "data/documents"}</code>, puis clique
                sur « Reindexer le dossier ».
              </p>
            </Card>
          )}
          {(data?.documents ?? []).map((document) => (
            <Card title={document.title} icon={<IconDocument size={14} />} key={document.id}>
              <div className="stack">
                <div className="field">
                  <span className="k">source</span>
                  <span className="v">{document.source}</span>
                </div>
                <div className="field">
                  <span className="k">passages</span>
                  <span className="v">{document.chunk_count}</span>
                </div>
                {document.bytes > 0 && (
                  <div className="field">
                    <span className="k">taille</span>
                    <span className="v">{humanSize(document.bytes)}</span>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    indexe {relative(document.indexed_at)}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn small"
                    onClick={() => remove(document.id)}
                    title="Retirer de l'index (le fichier n'est pas supprime)"
                  >
                    <IconTrash /> Retirer
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
