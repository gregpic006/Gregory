import type { ToolActivity } from "../lib/types";

/** Ce que JARVIS consulte, en direct.
 *
 * On montre l'outil, son statut et le resultat succinct — jamais le
 * raisonnement interne du modele. C'est une regle du produit, pas un detail
 * d'affichage: le raisonnement n'est ni fiable ni destine a l'utilisateur.
 */
export function ActivityRail({ items }: { items: ToolActivity[] }) {
  if (items.length === 0) return null;

  return (
    <div className="activity">
      {items.slice(0, 5).map((item) => (
        <div className="activity-item" data-status={item.status} key={item.id}>
          {item.status === "running" ? (
            <span className="activity-pulse" />
          ) : (
            <span className="row-dot" style={{ background: item.status === "ok" ? "var(--ok)" : "var(--danger)" }} />
          )}
          <span className="activity-name">{item.tool}</span>
          <span className="activity-detail">{item.summary ?? item.label}</span>
        </div>
      ))}
    </div>
  );
}
