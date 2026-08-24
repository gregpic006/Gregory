import { useCallback, useEffect, useState } from "react";

import { CommandBar } from "./components/CommandBar";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmBar } from "./components/ConfirmBar";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { useJarvis } from "./lib/useJarvis";
import type { ViewId } from "./lib/types";
import { BusinessesView } from "./views/BusinessesView";
import { ConversationView } from "./views/ConversationView";
import { DashboardView } from "./views/DashboardView";
import { HomeView } from "./views/HomeView";
import { IntegrationsView } from "./views/IntegrationsView";
import { DocumentsView } from "./views/DocumentsView";
import { MemoryView } from "./views/MemoryView";
import { SettingsView } from "./views/SettingsView";
import { CalendarView, EmailView, TasksView } from "./views/SourceViews";

const BRIEFING_PROMPT =
  "Fais-moi mon briefing: mes rendez-vous d'aujourd'hui, les courriels qui " +
  "meritent une reponse, et mes rappels en attente. Sois bref.";

/** Centre de commande JARVIS.
 *
 * Trois principes de disposition:
 * 1. Le noyau est l'element principal; l'information l'entoure.
 * 2. La barre de commande est toujours accessible, quelle que soit la vue.
 * 3. Le mode plein ecran efface la navigation et agrandit le noyau — c'est la
 *    vue « poste de pilotage » qu'on laisse ouverte sur un ecran dedie.
 */
export default function App() {
  const jarvis = useJarvis();
  const [view, setView] = useState<ViewId>("home");
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const navigate = useCallback((next: ViewId) => setView(next), []);

  const ask = useCallback(
    (question: string) => {
      jarvis.sendText(question);
      setView("home");
    },
    [jarvis],
  );

  const briefing = useCallback(() => {
    jarvis.sendText(BRIEFING_PROMPT);
    jarvis.refreshOverview();
    setView("home");
  }, [jarvis]);

  // Raccourcis globaux. Espace ne declenche le micro que hors champ de saisie
  // et seulement si un moteur de transcription existe reellement.
  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === "TEXTAREA" ||
        target.tagName === "INPUT" ||
        target.isContentEditable);

    const down = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        return;
      }
      if (event.code === "Space" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void jarvis.startRecording();
        return;
      }
      if (event.code !== "Space" || event.repeat || isTyping(event.target)) return;
      if (!jarvis.micAvailable || paletteOpen) return;
      event.preventDefault();
      void jarvis.startRecording();
    };

    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTyping(event.target)) return;
      if (!jarvis.micAvailable) return;
      event.preventDefault();
      void jarvis.stopRecording();
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [jarvis, paletteOpen]);

  const voiceLabel = jarvis.system?.providers.tts_available
    ? jarvis.system.providers.tts
    : jarvis.player.voiceName();

  const badges = {
    email:
      jarvis.overview?.panes.email.status === "connected"
        ? jarvis.overview.panes.email.messages.length
        : undefined,
    tasks: jarvis.overview?.panes.tasks.reminders.length || undefined,
  };

  return (
    <div className="app" data-collapsed={collapsed} data-fullscreen={fullscreen}>
      <Sidebar
        view={view}
        onNavigate={navigate}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        badges={badges}
      />

      <main className="main">
        <TopBar
          system={jarvis.system}
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((value) => !value)}
          onOpenSearch={() => setPaletteOpen(true)}
          voiceLabel={voiceLabel}
        />

        <div className="view">
          {jarvis.error && (
            <div className="banner" onClick={jarvis.dismissError} role="presentation">
              {jarvis.error}
            </div>
          )}

          {view === "home" && (
            <HomeView
              state={jarvis.state}
              detail={jarvis.detail}
              levelRef={jarvis.levelRef}
              overview={jarvis.overview}
              lastTurn={jarvis.lastTurn}
              transcript={jarvis.transcript}
              activity={jarvis.activity}
              fullscreen={fullscreen}
              onNavigate={navigate}
            />
          )}
          {view === "dashboard" && (
            <DashboardView
              overview={jarvis.overview}
              onNavigate={navigate}
              onBriefing={briefing}
            />
          )}
          {view === "conversation" && (
            <ConversationView
              messages={jarvis.messages}
              activity={jarvis.activity}
              assistantName={jarvis.system?.name ?? "Jarvis"}
            />
          )}
          {view === "calendar" && <CalendarView overview={jarvis.overview} />}
          {view === "email" && <EmailView overview={jarvis.overview} />}
          {view === "tasks" && <TasksView overview={jarvis.overview} />}
          {view === "businesses" && <BusinessesView />}
          {view === "documents" && <DocumentsView />}
          {view === "memory" && <MemoryView />}
          {view === "integrations" && (
            <IntegrationsView system={jarvis.system} onChanged={jarvis.refreshSystem} />
          )}
          {view === "settings" && (
            <SettingsView system={jarvis.system} player={jarvis.player} />
          )}
        </div>

        {jarvis.pending && <ConfirmBar action={jarvis.pending} onDecision={jarvis.decide} />}

        <CommandBar
          onSend={jarvis.sendText}
          onMicDown={() => void jarvis.startRecording()}
          onMicUp={() => void jarvis.stopRecording()}
          recording={jarvis.recording}
          micAvailable={jarvis.micAvailable}
        />
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        overview={jarvis.overview}
        onNavigate={navigate}
        onAsk={ask}
      />
    </div>
  );
}
