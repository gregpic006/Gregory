import { eventTime, relative, senderName } from "../lib/format";
import type { CalendarEvent, EmailHeader, PaneStatus, Reminder } from "../lib/types";
import { NotConnected } from "../components/Card";

/** Rend le contenu d'un volet selon son statut.
 *
 * Un seul endroit decide de ce qui s'affiche quand une source manque ou
 * echoue. C'est ce qui garantit qu'aucune vue ne peut, par distraction,
 * afficher un zero a la place d'une absence de donnee.
 */
export function PaneBody({
  status,
  detail,
  empty,
  children,
}: {
  status: PaneStatus;
  detail: string;
  empty: string;
  children: React.ReactNode;
}) {
  if (status === "not_connected") return <NotConnected detail={detail} />;
  if (status === "error") {
    return (
      <div className="stack">
        <span className="not-connected" style={{ color: "var(--danger)" }}>
          indisponible
        </span>
        <span className="card-empty">{detail}</span>
      </div>
    );
  }
  const hasContent = Array.isArray(children) ? children.length > 0 : Boolean(children);
  if (!hasContent) return <div className="card-empty">{empty}</div>;
  return <div className="row-list">{children}</div>;
}

export function EventRow({ event }: { event: CalendarEvent }) {
  return (
    <div className="row-item">
      <span className="row-time">{eventTime(event.start, event.all_day)}</span>
      <span className="row-main">{event.title || "(sans titre)"}</span>
      {event.location && <span className="row-sub">{event.location}</span>}
    </div>
  );
}

export function EmailRow({ message }: { message: EmailHeader }) {
  return (
    <div className="row-item">
      {message.unread && <span className="row-dot" />}
      <span className="row-main">
        <strong style={{ fontWeight: 500 }}>{senderName(message.from)}</strong>
        {" — "}
        <span className="muted">{message.subject || "(sans objet)"}</span>
      </span>
      <span className="row-sub">{relative(message.date)}</span>
    </div>
  );
}

export function ReminderRow({ reminder }: { reminder: Reminder }) {
  return (
    <div className="row-item">
      <span className="row-time">{reminder.due_label || reminder.due_at.slice(5, 10)}</span>
      <span className="row-main">{reminder.text}</span>
    </div>
  );
}
