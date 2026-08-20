-- Tarification V1 (brief TWIM) : le taux de coordination des travaux
-- (10 % par défaut) était codé en dur dans ops-api.ts — exactement ce
-- que le brief interdit ("ne pas coder comme valeur immuable"). Rendu
-- configurable par propriétaire, avec possibilité de forfait négocié
-- pour un gros projet, et sans défaut silencieux au-delà de 10 000 $
-- (appliqué côté edge function, voir ops-api.ts create_work_order /
-- dispatch_work_order_auto).
alter table owners add column if not exists work_coordination_rate numeric(4,2) default 10.00;

-- Snapshot du taux réellement appliqué à ce chantier (traçabilité —
-- le taux par défaut du propriétaire peut changer après coup, la
-- facture doit refléter ce qui a été appliqué au moment du mandat).
-- Null quand coordination_fee vient d'un forfait négocié plutôt que
-- d'un taux.
alter table work_orders add column if not exists coordination_rate numeric(4,2);
alter table work_orders add column if not exists coordination_fee_type text
  check (coordination_fee_type is null or coordination_fee_type in ('taux', 'forfait'));
