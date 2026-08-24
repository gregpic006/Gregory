import { useEffect, useState } from "react";

import { Card } from "../components/Card";
import { IconBuilding } from "../components/layout/icons";
import { fetchBusinesses } from "../lib/api";
import type { BusinessOrg } from "../lib/types";

/** Centre de commande business.
 *
 * La page existe des maintenant pour que la structure soit prete, mais aucun
 * indicateur n'affiche de valeur tant qu'une source reelle n'est pas branchee.
 * Un chiffre plausible mais faux serait pire que pas de chiffre du tout.
 */
export function BusinessesView() {
  const [organizations, setOrganizations] = useState<BusinessOrg[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    fetchBusinesses()
      .then((payload) => {
        setOrganizations(payload.organizations);
        setNote(payload.note);
      })
      .catch(() => setNote("Impossible de charger les organisations."));
  }, []);

  return (
    <>
      <div className="dash-head">
        <h1>Entreprises</h1>
        <p>Une organisation, un contexte, ses propres sources de donnees.</p>
      </div>
      <p className="section-note">{note}</p>

      <div className="grid">
        {organizations.map((org) => (
          <Card title={org.name} icon={<IconBuilding size={14} />} key={org.id}>
            <div className="stack">
              {org.metrics.length === 0 ? (
                <span className="not-connected">non connecte</span>
              ) : (
                org.metrics.map((metric) => (
                  <div className="field" key={metric.label}>
                    <span className="k">{metric.label}</span>
                    <span className="v off">
                      {metric.status === "connected" ? metric.value : "non connecte"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
