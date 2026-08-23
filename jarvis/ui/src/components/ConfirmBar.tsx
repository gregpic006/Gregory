import type { PendingAction } from "../lib/types";

const LEVELS = ["lecture", "ecriture locale", "communication externe", "sensible", "critique"];

interface Props {
  action: PendingAction;
  onDecision: (approved: boolean) => void;
}

/** Barre de confirmation pour les actions a effet exterieur ou irreversible. */
export function ConfirmBar({ action, onDecision }: Props) {
  return (
    <div className="confirm">
      <div className="text">
        <b>Confirmation requise</b> — {action.description}
        <div className="level">
          palier {action.permission_level} · {LEVELS[action.permission_level] ?? "inconnu"}
        </div>
      </div>
      <button className="btn primary" onClick={() => onDecision(true)}>
        Vas-y
      </button>
      <button className="btn ghost" onClick={() => onDecision(false)}>
        Annule
      </button>
    </div>
  );
}
