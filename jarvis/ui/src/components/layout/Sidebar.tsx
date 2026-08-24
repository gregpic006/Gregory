import type { ReactNode } from "react";

import type { ViewId } from "../../lib/types";
import {
  IconBrain, IconBuilding, IconCalendar, IconChat, IconCheck, IconChevron,
  IconDocument, IconGear, IconGrid, IconHome, IconMail, IconPlug,
} from "./icons";

interface NavEntry {
  id: ViewId;
  label: string;
  icon: ReactNode;
  group: string;
}

const ENTRIES: NavEntry[] = [
  { id: "home", label: "Accueil", icon: <IconHome />, group: "" },
  { id: "dashboard", label: "Tableau de bord", icon: <IconGrid />, group: "" },
  { id: "conversation", label: "Conversation", icon: <IconChat />, group: "" },
  { id: "calendar", label: "Calendrier", icon: <IconCalendar />, group: "Sources" },
  { id: "email", label: "Courriels", icon: <IconMail />, group: "Sources" },
  { id: "tasks", label: "Rappels", icon: <IconCheck />, group: "Sources" },
  { id: "documents", label: "Documents", icon: <IconDocument />, group: "Sources" },
  { id: "businesses", label: "Entreprises", icon: <IconBuilding />, group: "Sources" },
  { id: "memory", label: "Memoire", icon: <IconBrain />, group: "Systeme" },
  { id: "integrations", label: "Integrations", icon: <IconPlug />, group: "Systeme" },
  { id: "settings", label: "Reglages", icon: <IconGear />, group: "Systeme" },
];

interface Props {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  collapsed: boolean;
  onToggle: () => void;
  badges: Partial<Record<ViewId, number>>;
}

/** Navigation principale. Reductible aux seules icones. */
export function Sidebar({ view, onNavigate, collapsed, onToggle, badges }: Props) {
  let lastGroup = "";

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark" />
        <span className="sidebar-name">JARVIS</span>
      </div>

      <nav className="nav">
        {ENTRIES.map((entry) => {
          const header = entry.group && entry.group !== lastGroup ? entry.group : null;
          lastGroup = entry.group;
          const badge = badges[entry.id];
          return (
            <div key={entry.id}>
              {header && <div className="nav-group">{header}</div>}
              <button
                className="nav-item"
                data-active={view === entry.id}
                onClick={() => onNavigate(entry.id)}
                title={collapsed ? entry.label : undefined}
              >
                {entry.icon}
                <span className="nav-label">{entry.label}</span>
                {badge ? <span className="nav-badge">{badge}</span> : null}
              </button>
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button className="nav-item" onClick={onToggle} title="Reduire le menu">
          <span style={{ transform: collapsed ? "none" : "rotate(180deg)", display: "flex" }}>
            <IconChevron />
          </span>
          <span className="nav-label">Reduire</span>
        </button>
      </div>
    </aside>
  );
}
