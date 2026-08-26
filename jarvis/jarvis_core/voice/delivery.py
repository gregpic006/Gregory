"""Le debit et la hauteur: ce qui distingue un assistant d'un GPS.

Le timbre ne fait pas la voix de JARVIS. Dans les films, ce qui frappe n'est
pas la couleur du son mais la **tenue**: un debit legerement en dessous du
naturel, une hauteur basse, aucune emphase. Il ne vend rien, il ne s'excuse
pas, il ne s'excite pas.

Une voix neuronale reglee a plat sonne comme une annonce d'aeroport. Les
memes mots, ralentis de quelques pour cent et descendus de quelques hertz,
sonnent posés.

Ces valeurs sont un point de depart, pas une verite: l'oreille tranche, et
l'utilisateur les ajuste depuis les Reglages.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Delivery:
    """Une facon de porter la voix."""

    key: str
    label: str
    description: str
    rate: str
    pitch: str

    def as_dict(self) -> dict[str, str]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "rate": self.rate,
            "pitch": self.pitch,
        }


#: Pose, bas, sans emphase. Le defaut.
JARVIS = Delivery(
    key="jarvis",
    label="JARVIS",
    description="Pose et grave. Ne se presse jamais.",
    rate="-7%",
    pitch="-12Hz",
)

DELIVERIES: tuple[Delivery, ...] = (
    JARVIS,
    Delivery(
        key="grave",
        label="Plus grave",
        description="Meme debit, voix plus basse.",
        rate="-7%",
        pitch="-25Hz",
    ),
    Delivery(
        key="vif",
        label="Plus vif",
        description="Le meme timbre, mais qui va droit au but.",
        rate="+4%",
        pitch="-8Hz",
    ),
    Delivery(
        key="neutre",
        label="Neutre",
        description="La voix telle que le moteur la produit.",
        rate="+0%",
        pitch="+0Hz",
    ),
)

BY_KEY = {delivery.key: delivery for delivery in DELIVERIES}


def get_delivery(key: str) -> Delivery:
    """La tenue demandee, ou celle de JARVIS si le nom est inconnu."""
    return BY_KEY.get(key.strip().lower(), JARVIS)
