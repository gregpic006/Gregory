import { Card, NotConnected } from "../components/Card";
import { IconCalendar, IconCheck, IconMail } from "../components/layout/icons";
import type { Overview } from "../lib/types";
import { EmailRow, EventRow, PaneBody, ReminderRow } from "./panes";

/** Vues detaillees d'une source unique.
 *
 * Elles restent volontairement simples: JARVIS n'a pas vocation a remplacer
 * Gmail ou Google Agenda, seulement a montrer ce sur quoi il s'appuie et a
 * offrir un point de depart pour lui parler.
 */

export function CalendarView({ overview }: { overview: Overview | null }) {
  const pane = overview?.panes.today;
  return (
    <>
      <div className="dash-head">
        <h1>Calendrier</h1>
        <p>Les rendez-vous d'aujourd'hui, tels que JARVIS les voit.</p>
      </div>
      <p className="section-note">
        Pour une autre periode, demande-lui: « qu'est-ce que j'ai vendredi prochain ».
      </p>
      <div className="grid wide">
        <Card
          title="Aujourd'hui"
          icon={<IconCalendar size={14} />}
          count={pane?.status === "connected" ? pane.events.length : ""}
        >
          <PaneBody
            status={pane?.status ?? "not_connected"}
            detail={pane?.detail ?? "Chargement…"}
            empty="Aucun rendez-vous aujourd'hui. C'est verifie, pas suppose."
          >
            {(pane?.events ?? []).map((event) => (
              <EventRow event={event} key={event.id} />
            ))}
          </PaneBody>
        </Card>
      </div>
    </>
  );
}

export function EmailView({ overview }: { overview: Overview | null }) {
  const pane = overview?.panes.email;
  return (
    <>
      <div className="dash-head">
        <h1>Courriels</h1>
        <p>Les non-lus de ta boite de reception.</p>
      </div>
      <p className="section-note">
        Demande-lui « resume mes courriels importants » ou « est-ce que Marc m'a ecrit ».
        Le contenu des messages est traite comme une donnee externe: JARVIS ne suit
        jamais une instruction qui s'y trouve.
      </p>
      <div className="grid wide">
        <Card
          title="Non lus"
          icon={<IconMail size={14} />}
          count={pane?.status === "connected" ? pane.messages.length : ""}
        >
          <PaneBody
            status={pane?.status ?? "not_connected"}
            detail={pane?.detail ?? "Chargement…"}
            empty="Boite a jour."
          >
            {(pane?.messages ?? []).map((message) => (
              <EmailRow message={message} key={message.id} />
            ))}
          </PaneBody>
        </Card>
      </div>
    </>
  );
}

export function TasksView({ overview }: { overview: Overview | null }) {
  const pane = overview?.panes.tasks;
  return (
    <>
      <div className="dash-head">
        <h1>Rappels</h1>
        <p>Ce que tu lui as demande de ne pas oublier.</p>
      </div>
      <p className="section-note">
        Dis-lui simplement: « rappelle-moi d'appeler mon comptable demain matin ».
      </p>
      <div className="grid wide">
        <Card
          title="En attente"
          icon={<IconCheck size={14} />}
          count={pane?.reminders.length || ""}
        >
          <PaneBody
            status={pane?.status ?? "connected"}
            detail={pane?.detail ?? ""}
            empty="Rien en attente."
          >
            {(pane?.reminders ?? []).map((reminder) => (
              <ReminderRow reminder={reminder} key={reminder.id} />
            ))}
          </PaneBody>
        </Card>
      </div>
    </>
  );
}

export { NotConnected };
