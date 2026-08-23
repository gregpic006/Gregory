import { useEffect, useRef } from "react";

import type { ChatMessage } from "../lib/types";

interface Props {
  messages: ChatMessage[];
  assistantName: string;
}

/** Fil de conversation. Les sources sont cliquables quand une URL existe. */
export function Conversation({ messages, assistantName }: Props) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="conversation">
        <div className="empty">
          Maintiens <b>Espace</b> et parle, ou ecris ci-dessous.
          <br />
          Essaie: « Bon matin {assistantName} »
        </div>
      </div>
    );
  }

  return (
    <div className="conversation">
      {messages.map((message) => (
        <div key={message.id} className={`turn ${message.role}`}>
          <div className="who">{message.role === "user" ? "toi" : assistantName}</div>
          <div className="bubble">
            {message.text}
            {message.streaming && <span className="cursor">▌</span>}
          </div>
          {message.citations && message.citations.length > 0 && (
            <div className="citations">
              {message.citations.map((citation, index) => (
                <span className="citation" key={`${message.id}-${index}`}>
                  <strong>{citation.label}</strong>
                  {citation.locator ? ` — ${citation.locator}` : ""}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      <div ref={bottom} />
    </div>
  );
}
