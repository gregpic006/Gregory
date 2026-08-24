import type { ReactNode } from "react";

interface Props {
  title: string;
  icon?: ReactNode;
  count?: number | string;
  children: ReactNode;
  onClick?: () => void;
}

/** Carte du tableau de bord: verre depoli, bordure fine, lueur au survol. */
export function Card({ title, icon, count, children, onClick }: Props) {
  return (
    <section
      className="card"
      data-clickable={onClick ? "true" : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(event) => {
        if (onClick && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <div className="card-head">
        {icon}
        <span className="card-title">{title}</span>
        {count !== undefined && count !== "" && <span className="card-count">{count}</span>}
      </div>
      {children}
    </section>
  );
}

/** Mention d'absence de source. Elle remplace une valeur, jamais l'inverse. */
export function NotConnected({ detail }: { detail?: string }) {
  return (
    <div className="stack">
      <span className="not-connected">non connecte</span>
      {detail && <span className="card-empty">{detail}</span>}
    </div>
  );
}
