import type { Citation } from "../lib/types";

/** Sources d'une reponse. Cliquables quand la source a une adresse. */
export function Sources({ items }: { items: Citation[] }) {
  if (items.length === 0) return null;

  return (
    <div className="sources">
      {items.map((citation, index) => {
        const content = (
          <>
            <span className="source-kind">{citation.kind}</span>
            <span>{citation.label}</span>
            {citation.locator && <span className="muted">— {citation.locator}</span>}
          </>
        );
        return citation.url ? (
          <a
            className="source"
            key={`${citation.label}-${index}`}
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {content}
          </a>
        ) : (
          <span className="source" key={`${citation.label}-${index}`}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
