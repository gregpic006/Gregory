import { ActivityRail } from "../components/ActivityRail";
import { Card } from "../components/Card";
import { JarvisCore } from "../components/core/JarvisCore";
import { Sources } from "../components/Sources";
import {
  IconBuilding, IconCalendar, IconCheck, IconDocument, IconMail,
} from "../components/layout/icons";
import { greeting } from "../lib/format";
import type { AssistantState, ChatMessage, Overview, ToolActivity, ViewId } from "../lib/types";
import { useCoreSize } from "../lib/viewport";
import { EmailRow, EventRow, PaneBody, ReminderRow } from "./panes";

interface Props {
  state: AssistantState;
  detail: string;
  levelRef: { current: number };
  overview: Overview | null;
  lastTurn: ChatMessage | null;
  transcript: string;
  activity: ToolActivity[];
  fullscreen: boolean;
  onNavigate: (view: ViewId) => void;
}

const STATE_LABEL: Record<AssistantState, string> = {
  idle: "en veille",
  listening: "j'ecoute",
  transcribing: "transcription",
  understanding: "analyse",
  working: "recherche",
  speaking: "reponse",
};

/** Ecran d'accueil: le noyau au centre, l'information autour.
 *
 * Ce qui entoure le noyau n'est pas decoratif: ce sont les quatre questions
 * auxquelles un centre de commande doit repondre d'un coup d'oeil — qu'est-ce
 * qui se passe, qu'est-ce qui m'attend, ou en sont mes affaires, que dois-je
 * faire.
 */
export function HomeView({
  state, detail, levelRef, overview, lastTurn, transcript, activity, fullscreen, onNavigate,
}: Props) {
  const panes = overview?.panes;
  const hour = new Date().getHours();
  const coreSize = useCoreSize(fullscreen);

  // Sous le noyau, on annonce l'outil en cours de consultation — jamais le
  // raisonnement du modele. « connecte » est un detail de transport: inutile
  // a l'ecran.
  const running = activity.find((item) => item.status === "running");
  const caption = running
    ? running.label
    : detail && detail !== "connecte"
      ? detail
      : state === "idle"
        ? ""
        : detail;

  return (
    <div className="home">
      <div className="home-side">
        <Card
          title="Aujourd'hui"
          icon={<IconCalendar size={14} />}
          count={panes?.today.status === "connected" ? panes.today.events.length : ""}
          onClick={() => onNavigate("calendar")}
        >
          <PaneBody
            status={panes?.today.status ?? "not_connected"}
            detail={panes?.today.detail ?? "Chargement…"}
            empty="Aucun rendez-vous aujourd'hui."
          >
            {(panes?.today.events ?? []).slice(0, 4).map((event) => (
              <EventRow event={event} key={event.id} />
            ))}
          </PaneBody>
        </Card>

        <Card
          title="Entreprises"
          icon={<IconBuilding size={14} />}
          onClick={() => onNavigate("businesses")}
        >
          <PaneBody
            status={panes?.business.status ?? "not_connected"}
            detail={panes?.business.detail ?? "Chargement…"}
            empty=""
          >
            {null}
          </PaneBody>
        </Card>

        <Card
          title="Documents"
          icon={<IconDocument size={14} />}
          count={panes?.documents.count || ""}
          onClick={() => onNavigate("documents")}
        >
          <PaneBody
            status={panes?.documents.status ?? "not_connected"}
            detail={panes?.documents.detail ?? "Chargement…"}
            empty=""
          >
            {null}
          </PaneBody>
        </Card>
      </div>

      <div className="home-center">
        <div className="core-greeting">
          <h1>{greeting(hour, overview?.user ?? "")}</h1>
          <p>{transcript || "Qu'est-ce que je peux faire pour toi ?"}</p>
        </div>

        <div className="core-stage">
          <JarvisCore state={state} levelRef={levelRef} size={coreSize} />
          <div className="core-caption">
            <div className="core-state" key={state}>
              {STATE_LABEL[state]}
            </div>
            <div className="core-detail">{caption}</div>
          </div>
        </div>

        {activity.length > 0 && (
          <div style={{ width: "100%", maxWidth: 440 }}>
            <ActivityRail items={activity} />
          </div>
        )}

        {lastTurn && (
          <div style={{ width: "100%", maxWidth: 560, textAlign: "center" }}>
            <div className="bubble" style={{ maxWidth: "100%", textAlign: "left" }}>
              {lastTurn.text}
              {lastTurn.streaming && <span className="cursor">▌</span>}
            </div>
            <Sources items={lastTurn.citations ?? []} />
          </div>
        )}
      </div>

      <div className="home-side">
        <Card
          title="Courriels"
          icon={<IconMail size={14} />}
          count={panes?.email.status === "connected" ? panes.email.messages.length : ""}
          onClick={() => onNavigate("email")}
        >
          <PaneBody
            status={panes?.email.status ?? "not_connected"}
            detail={panes?.email.detail ?? "Chargement…"}
            empty="Aucun courriel non lu."
          >
            {(panes?.email.messages ?? []).slice(0, 4).map((message) => (
              <EmailRow message={message} key={message.id} />
            ))}
          </PaneBody>
        </Card>

        <Card
          title="Rappels"
          icon={<IconCheck size={14} />}
          count={panes?.tasks.reminders.length || ""}
          onClick={() => onNavigate("tasks")}
        >
          <PaneBody
            status={panes?.tasks.status ?? "connected"}
            detail={panes?.tasks.detail ?? ""}
            empty="Rien en attente."
          >
            {(panes?.tasks.reminders ?? []).slice(0, 4).map((reminder) => (
              <ReminderRow reminder={reminder} key={reminder.id} />
            ))}
          </PaneBody>
        </Card>
      </div>
    </div>
  );
}
