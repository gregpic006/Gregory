import { useEffect, useRef } from "react";

import { ActivityRail } from "../components/ActivityRail";
import { Sources } from "../components/Sources";
import type { ChatMessage, ToolActivity } from "../lib/types";

interface Props {
  messages: ChatMessage[];
  activity: ToolActivity[];
  assistantName: string;
}

/** Le fil complet. La reponse courte vit sur l'accueil; l'historique vit ici. */
export function ConversationView({ messages, activity, assistantName }: Props) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="thread">
        <div className="card-empty" style={{ textAlign: "center", padding: "60px 0" }}>
          Rien encore. Parle a {assistantName}, ou ecris ta demande en bas de l'ecran.
        </div>
      </div>
    );
  }

  return (
    <div className="thread">
      {messages.map((message) => (
        <div className={`turn ${message.role}`} key={message.id}>
          <span className="who">{message.role === "user" ? "toi" : assistantName}</span>
          <div className="bubble">
            {message.text}
            {message.streaming && <span className="cursor">▌</span>}
          </div>
          <Sources items={message.citations ?? []} />
        </div>
      ))}
      {activity.length > 0 && <ActivityRail items={activity} />}
      <div ref={bottom} />
    </div>
  );
}
