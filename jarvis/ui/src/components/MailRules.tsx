import { useCallback, useEffect, useState } from "react";

import { Card } from "./Card";
import { IconMail } from "./layout/icons";
import {
  addMailRule,
  fetchMailRules,
  removeMailRule,
  scanMailNow,
  type MailRule,
  type MailScanReport,
} from "../lib/api";
import type { BusinessOrg } from "../lib/types";

/**
 * Connecter un logiciel de gestion qui n'a pas d'API.
 *
 * La plupart n'en ont pas — Maitre'D, par exemple, reserve ses integrations a
 * des ententes commerciales, et tourne souvent sur un serveur dans le
 * commerce, hors d'atteinte depuis l'exterieur.
 *
 * Mais presque tous savent envoyer un rapport par courriel a heure fixe. Ce
 * rapport arrive dans une boite que JARVIS lit deja, en lecture seule.
 *
 * D'ou cette carte: designer un expediteur, et rien de plus. **Aucun mot de
 * passe n'est demande ici, et aucun ne doit l'etre.** JARVIS ne se connecte
 * jamais au logiciel de gestion; il lit ce que ce logiciel lui envoie.
 */

interface Props {
  organizations: BusinessOrg[];
}

export function MailRules({ organizations }: Props) {
  const [rules, setRules] = useState<MailRule[] | null>(null);
  const [blocked, setBlocked] = useState("");
  const [adding, setAdding] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [report, setReport] = useState<MailScanReport | null>(null);

  const refresh = useCallback(() => {
    fetchMailRules()
      .then((data) => {
        setRules(data.rules);
        setBlocked(data.blocked);
      })
      .catch(() => setRules([]));
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (!orgId && organizations.length > 0) setOrgId(organizations[0].id);
  }, [orgId, organizations]);

  const add = async () => {
    setBusy(true);
    setNote("");
    try {
      await addMailRule({ org_id: orgId, sender: sender.trim(), subject: subject.trim() });
      setSender("");
      setSubject("");
      setAdding(false);
      refresh();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Ajout impossible.");
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true);
    setNote("");
    setReport(null);
    try {
      setReport(await scanMailNow());
      refresh();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "Recherche impossible.");
    } finally {
      setBusy(false);
    }
  };

  const drop = async (rule: MailRule) => {
    await removeMailRule(rule.id).catch(() => undefined);
    refresh();
  };

  const nameOf = (id: string) =>
    organizations.find((org) => org.id === id)?.name ?? id;

  return (
    <Card
      title="Rapports par courriel"
      icon={<IconMail size={14} />}
      count={rules?.length ? String(rules.length) : ""}
    >
      <div className="stack">
        <p className="card-empty">
          Ton logiciel de gestion envoie un rapport par courriel ? Dis-moi de qui il
          vient et j'importe les chiffres tout seul. <b>Aucun mot de passe</b>: je ne
          me connecte pas a ton application, je lis ce qu'elle t'envoie.
        </p>

        {blocked && <p className="card-empty">{blocked}</p>}

        {rules === null ? (
          <p className="card-empty">Chargement…</p>
        ) : rules.length === 0 ? (
          <p className="card-empty">Aucun expediteur configure.</p>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {rules.map((rule) => (
              <div
                key={rule.id}
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{rule.sender}</b>
                  <span className="card-empty"> → {nameOf(rule.org_id)}</span>
                  {rule.subject && (
                    <span className="card-empty"> · objet « {rule.subject} »</span>
                  )}
                </span>
                <button className="btn small" onClick={() => drop(rule)}>
                  Retirer
                </button>
              </div>
            ))}
          </div>
        )}

        {adding ? (
          <div className="stack">
            <select
              className="input"
              value={orgId}
              onChange={(event) => setOrgId(event.target.value)}
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              placeholder="Adresse qui envoie le rapport (ex: rapports@macaisse.com)"
              value={sender}
              autoFocus
              onChange={(event) => setSender(event.target.value)}
            />
            <input
              className="input"
              style={{ fontFamily: "var(--sans)", fontSize: 13 }}
              placeholder="Objet du courriel (optionnel, si plusieurs rapports)"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn primary small"
                onClick={add}
                disabled={busy || !sender.trim() || !orgId}
              >
                Ajouter
              </button>
              <button className="btn small" onClick={() => setAdding(false)}>
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn small"
              onClick={() => setAdding(true)}
              disabled={organizations.length === 0}
            >
              + Ajouter un expediteur
            </button>
            {rules !== null && rules.length > 0 && (
              <button className="btn small" onClick={scan} disabled={busy}>
                {busy ? "Recherche…" : "Chercher maintenant"}
              </button>
            )}
          </div>
        )}

        {note && <p className="card-empty">{note}</p>}

        {report && (
          <div className="stack" style={{ gap: 4 }}>
            <p style={{ margin: 0, fontSize: 13 }}>{report.summary}</p>
            {report.imported.map((name) => (
              <span className="card-empty" key={name}>
                · {name}
              </span>
            ))}
            {report.failed.map((item) => (
              <span className="card-empty" key={item.name}>
                · {item.name} — {item.reason}
              </span>
            ))}
            {report.skipped.map((item) => (
              <span className="card-empty" key={item.name}>
                · {item.name} — {item.reason}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
