import { useCallback, useEffect, useState } from "react";

import { Card } from "../components/Card";
import { IconBrain, IconTrash } from "../components/layout/icons";
import { fetchMemory, forgetMemory, type MemoryResponse } from "../lib/api";
import { relative } from "../lib/format";

const KIND_LABELS: Record<string, string> = {
  personal: "Personnel",
  business: "Entreprises",
  event: "Decisions",
  preference: "Preferences",
};

/** Ce que JARVIS sait de toi.
 *
 * Chaque souvenir affiche sa source: c'est ce qui permet de repondre a « d'ou
 * tu sors ca ». Un souvenir sans provenance ne peut pas exister — le magasin
 * le refuse a l'ecriture.
 */
export function MemoryView() {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetchMemory(query, kind)
      .then(setData)
      .catch(() => setError("Impossible de lire la memoire."));
  }, [query, kind]);

  useEffect(() => {
    const timer = window.setTimeout(load, query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const remove = async (id: string) => {
    try {
      await forgetMemory(id);
      load();
    } catch {
      setError("Suppression impossible.");
    }
  };

  if (data && !data.enabled) {
    return (
      <>
        <div className="dash-head">
          <h1>Memoire</h1>
        </div>
        <p className="section-note">
          La memoire persistante est desactivee (JARVIS_FEATURE_PERSISTENT_MEMORY).
        </p>
      </>
    );
  }

  return (
    <>
      <div className="dash-head">
        <h1>Memoire</h1>
        <p>{data?.total ?? 0} souvenir(s), chacun avec sa source.</p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220, fontFamily: "var(--sans)", fontSize: 13 }}
          placeholder="Chercher un souvenir…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="input"
          style={{ width: 170 }}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">Tous les types</option>
          {Object.entries(KIND_LABELS).map(([value, label]) => (
            <option value={value} key={value}>
              {label} {data?.kinds[value] ? `(${data.kinds[value]})` : ""}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="grid">
        {(data?.memories ?? []).map((memory) => (
          <Card
            title={KIND_LABELS[memory.kind] ?? memory.kind}
            icon={<IconBrain size={14} />}
            key={memory.id}
          >
            <div className="stack">
              {memory.subject && (
                <span className="metric-label">{memory.subject}</span>
              )}
              <p style={{ margin: 0, lineHeight: 1.6, fontSize: 13.5 }}>{memory.content}</p>
              <div className="field">
                <span className="k">source</span>
                <span className="v">{memory.source}</span>
              </div>
              <div className="field">
                <span className="k">confiance</span>
                <span className="v">{Math.round(memory.confidence * 100)} %</span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 2,
                }}
              >
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {relative(memory.created_at)}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="btn small"
                  onClick={() => remove(memory.id)}
                  title="Supprimer definitivement"
                >
                  <IconTrash /> Oublier
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {data && data.memories.length === 0 && (
        <p className="section-note">
          Rien ici. Dis-lui « retiens que Xavier est mon associe dans Portail ».
        </p>
      )}
    </>
  );
}
