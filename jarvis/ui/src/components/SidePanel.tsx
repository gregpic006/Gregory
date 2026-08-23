import type { MetricsSnapshot } from "../lib/api";
import type { SystemInfo, ToolActivity } from "../lib/types";

interface Props {
  system: SystemInfo | null;
  activity: ToolActivity[];
  metrics: MetricsSnapshot | null;
}

/** Panneau lateral: ce que JARVIS fait, ce qui est branche, ce que ca coute. */
export function SidePanel({ system, activity, metrics }: Props) {
  return (
    <aside className="side">
      <section className="panel">
        <h2>Activite</h2>
        {activity.length === 0 ? (
          <div className="row">
            <span className="k">Aucune action recente</span>
          </div>
        ) : (
          <div className="activity">
            {activity.map((item) => (
              <div className="activity-item" data-status={item.status} key={item.id}>
                <span className="name">{item.tool}</span>
                <span className="detail">{item.summary ?? item.label}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {system && (
        <>
          <section className="panel">
            <h2>Moteurs</h2>
            <Row k="Raisonnement" v={system.providers.llm} on={system.providers.llm !== "mock"} />
            <Row k="Modele" v={system.providers.llm_models.balanced} />
            <Row
              k="Reconnaissance"
              v={system.providers.stt}
              on={system.providers.stt_available}
            />
            <Row
              k="Voix"
              v={system.providers.tts_available ? system.providers.tts : "systeme"}
              on={system.providers.tts_available}
            />
            <Row k="Fuseau" v={system.timezone} />
          </section>

          <section className="panel">
            <h2>Integrations</h2>
            {Object.entries(system.features).map(([name, enabled]) => (
              <Row key={name} k={name} v={enabled ? "actif" : "—"} on={enabled} />
            ))}
          </section>

          <section className="panel">
            <h2>Outils ({system.tools.filter((t) => t.available).length})</h2>
            <div className="tool-list">
              {system.tools.map((tool) => (
                <span
                  className="tool-pill"
                  key={tool.name}
                  data-available={tool.available}
                  data-level={tool.permission}
                  title={`${tool.description} (palier ${tool.permission})`}
                >
                  {tool.name}
                </span>
              ))}
            </div>
          </section>
        </>
      )}

      {metrics && (
        <section className="panel">
          <h2>Mesures</h2>
          <Row k="Tours" v={String(metrics.turns)} />
          <Row k="Latence p50" v={`${metrics.latency_ms.turn.p50} ms`} />
          <Row k="Latence p95" v={`${metrics.latency_ms.turn.p95} ms`} />
          <Row k="Echec outils" v={`${Math.round(metrics.tools.failure_rate * 100)} %`} />
          <Row
            k="Cout du jour"
            v={`${(metrics.llm_spend.spent_usd ?? 0).toFixed(3)} $ US`}
          />
        </section>
      )}
    </aside>
  );
}

function Row({ k, v, on }: { k: string; v: string; on?: boolean }) {
  const className = on === undefined ? "v" : on ? "v on" : "v off";
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className={className}>{v}</span>
    </div>
  );
}
