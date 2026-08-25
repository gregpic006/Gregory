import { useEffect, useState } from "react";

import { Card, NotConnected } from "../components/Card";
import {
  fetchBriefing,
  fetchBusinesses,
  generateBriefing,
  type Briefing,
  type BusinessesResponse,
} from "../lib/api";
import { IconAlert, IconBrain, IconBuilding, IconCalendar, IconCheck, IconMail } from "../components/layout/icons";
import { greeting, longDate } from "../lib/format";
import type { Overview, ViewId } from "../lib/types";
import { EmailRow, EventRow, PaneBody, ReminderRow } from "./panes";

interface Props {
  overview: Overview | null;
  onNavigate: (view: ViewId) => void;
  onBriefing: () => void;
}

/** Tableau de bord: la journee en un ecran.
 *
 * Meme information que l'accueil, mais dense et sans le noyau: c'est la vue
 * qu'on consulte, pas celle a qui l'on parle.
 */
export function DashboardView({ overview, onNavigate, onBriefing }: Props) {
  const panes = overview?.panes;
  const now = new Date();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [working, setWorking] = useState(false);
  const [businesses, setBusinesses] = useState<BusinessesResponse | null>(null);

  useEffect(() => {
    fetchBriefing()
      .then((payload) => {
        setBriefing(payload.briefing);
        setScheduledAt(payload.scheduled_at);
      })
      .catch(() => undefined);
    fetchBusinesses(7).then(setBusinesses).catch(() => undefined);
  }, []);

  // Le briefing ecrit est genere par le serveur a partir des seules sources
  // qu'il a pu consulter; « le lire a voix haute » passe par la conversation.
  const regenerate = async () => {
    setWorking(true);
    try {
      setBriefing(await generateBriefing());
    } catch {
      /* le bouton reste disponible: rien n'est affiche de faux */
    } finally {
      setWorking(false);
    }
  };

  // Ce qui merite l'attention: deduit de donnees reelles, jamais invente.
  const alerts: string[] = [];
  if (panes?.today.status === "error") alerts.push(`Calendrier: ${panes.today.detail}`);
  if (panes?.email.status === "error") alerts.push(`Courriels: ${panes.email.detail}`);
  const unread = panes?.email.status === "connected" ? panes.email.messages.length : 0;
  if (unread >= 5) alerts.push(`${unread} courriels non lus attendent une reponse.`);
  const overdue = (panes?.tasks.reminders ?? []).filter(
    (reminder) => new Date(reminder.due_at) < now,
  );
  if (overdue.length > 0) alerts.push(`${overdue.length} rappel(s) en retard.`);

  return (
    <>
      <div className="dash-head">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1>{greeting(now.getHours(), overview?.user ?? "")}</h1>
            <p>{longDate(now)}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn accent" onClick={onBriefing}>
              Me le lire
            </button>
            <button className="btn" onClick={regenerate} disabled={working}>
              {working ? "Redaction…" : briefing ? "Actualiser" : "Generer le briefing"}
            </button>
          </div>
        </div>
      </div>

      {briefing && (
        <div className="briefing">
          <p>{briefing.text}</p>
          <div className="briefing-foot">
            <span className="briefing-sources">
              {briefing.sources.length > 0
                ? `sources: ${briefing.sources.join(", ")}`
                : "aucune source branchee"}
            </span>
            <span style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 11.5 }}>
              {briefing.day}
              {scheduledAt ? ` · automatique a ${scheduledAt}` : ""}
            </span>
          </div>
        </div>
      )}

      {businesses?.enabled && businesses.organizations.length > 0 && (
        <>
          <h2 className="section-title">
            Entreprises
            <span className="section-note-inline">
              {businesses.period.start
                ? `du ${businesses.period.start} au ${businesses.period.end}`
                : ""}
            </span>
          </h2>
          <div className="grid" style={{ marginBottom: 22 }}>
            {businesses.organizations.map((org) => {
              const live = org.metrics.filter((metric) => metric.value !== null);
              return (
                <Card
                  title={org.name}
                  icon={<IconBuilding size={14} />}
                  count={live.length || ""}
                  onClick={() => onNavigate("businesses")}
                  key={org.id}
                >
                  {live.length === 0 ? (
                    <NotConnected
                      detail={`Aucune donnee. Importe un CSV depuis l'onglet Entreprises.`}
                    />
                  ) : (
                    <div className="stack">
                      {live.slice(0, 4).map((metric) => (
                        <div className="metric-row" key={metric.metric}>
                          <div className="field">
                            <span className="k">{metric.label}</span>
                            <span
                              className="v"
                              style={
                                metric.status === "stale" ? { color: "var(--warn)" } : {}
                              }
                            >
                              {metric.display}
                            </span>
                          </div>
                          {!metric.complete && (
                            <span className="metric-note">
                              {metric.days_covered}/{metric.days_requested} jours
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      <div className="grid">
        <Card
          title="Horaire du jour"
          icon={<IconCalendar size={14} />}
          count={panes?.today.status === "connected" ? panes.today.events.length : ""}
          onClick={() => onNavigate("calendar")}
        >
          <PaneBody
            status={panes?.today.status ?? "not_connected"}
            detail={panes?.today.detail ?? "Chargement…"}
            empty="Aucun rendez-vous aujourd'hui."
          >
            {(panes?.today.events ?? []).map((event) => (
              <EventRow event={event} key={event.id} />
            ))}
          </PaneBody>
        </Card>

        <Card title="Ce qui merite ton attention" icon={<IconAlert size={14} />}>
          {alerts.length === 0 ? (
            <div className="card-empty">
              Rien d'anormal detecte a partir des sources connectees.
            </div>
          ) : (
            <div className="row-list">
              {alerts.map((alert) => (
                <div className="row-item" key={alert}>
                  <span className="row-dot" style={{ background: "var(--warn)" }} />
                  <span className="row-main" style={{ whiteSpace: "normal" }}>{alert}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Courriels non lus"
          icon={<IconMail size={14} />}
          count={panes?.email.status === "connected" ? panes.email.messages.length : ""}
          onClick={() => onNavigate("email")}
        >
          <PaneBody
            status={panes?.email.status ?? "not_connected"}
            detail={panes?.email.detail ?? "Chargement…"}
            empty="Boite a jour."
          >
            {(panes?.email.messages ?? []).map((message) => (
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
            {(panes?.tasks.reminders ?? []).map((reminder) => (
              <ReminderRow reminder={reminder} key={reminder.id} />
            ))}
          </PaneBody>
        </Card>

        <Card
          title="Memoire"
          icon={<IconBrain size={14} />}
          count={panes?.memory.count ?? ""}
          onClick={() => onNavigate("memory")}
        >
          <PaneBody
            status={panes?.memory.status ?? "not_connected"}
            detail={panes?.memory.detail ?? "Chargement…"}
            empty="Rien en memoire pour l'instant."
          >
            {panes?.memory.count ? (
              <div className="metric">
                <span className="metric-value">{panes.memory.count}</span>
                <span className="metric-label">souvenirs, tous avec leur source</span>
              </div>
            ) : null}
          </PaneBody>
        </Card>
      </div>
    </>
  );
}
