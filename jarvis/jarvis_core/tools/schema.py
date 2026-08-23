"""Validateur de schema JSON minimal pour les appels d'outils.

Le modele produit les parametres; on ne les fait jamais confiance aveuglement.
On valide types, champs requis, enums et bornes avant d'executer quoi que ce
soit.  Volontairement minimal (pas de dependance externe): on ne supporte que
le sous-ensemble utilise par les schemas d'outils.
"""

from __future__ import annotations

from typing import Any

from jarvis_core.errors import ToolValidationError

_TYPE_MAP: dict[str, tuple[type, ...]] = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "array": (list,),
    "object": (dict,),
}


def validate_arguments(schema: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    """Valide et normalise les arguments d'un outil.

    Args:
        schema: schema JSON de l'outil (`type: object`).
        arguments: parametres proposes par le modele.

    Returns:
        Les arguments filtres aux seules proprietes declarees.

    Raises:
        ToolValidationError: si un champ requis manque ou si un type est faux.
    """
    if not isinstance(arguments, dict):
        raise ToolValidationError(
            f"arguments doivent etre un objet, recu {type(arguments).__name__}"
        )

    properties: dict[str, Any] = schema.get("properties", {})
    required: list[str] = schema.get("required", [])

    missing = [name for name in required if name not in arguments or arguments[name] is None]
    if missing:
        raise ToolValidationError(f"parametres manquants: {', '.join(missing)}")

    cleaned: dict[str, Any] = {}
    for name, value in arguments.items():
        spec = properties.get(name)
        if spec is None:
            # Propriete inconnue: on la jette plutot que de la propager.
            continue
        cleaned[name] = _validate_value(name, spec, value)
    return cleaned


def _validate_value(name: str, spec: dict[str, Any], value: Any) -> Any:
    expected = spec.get("type")
    if expected and value is not None:
        allowed = _TYPE_MAP.get(expected)
        if allowed is None:
            return value
        # `bool` est une sous-classe de `int` en Python: on l'exclut explicitement.
        if expected in {"integer", "number"} and isinstance(value, bool):
            raise ToolValidationError(f"'{name}' doit etre de type {expected}")
        if not isinstance(value, allowed):
            if expected == "number" and isinstance(value, str):
                try:
                    return float(value)
                except ValueError as exc:
                    raise ToolValidationError(f"'{name}' doit etre un nombre") from exc
            raise ToolValidationError(
                f"'{name}' doit etre de type {expected}, recu {type(value).__name__}"
            )

    enum = spec.get("enum")
    if enum is not None and value not in enum:
        raise ToolValidationError(f"'{name}' doit valoir l'une de: {', '.join(map(str, enum))}")

    if isinstance(value, str):
        max_length = spec.get("maxLength")
        if max_length is not None and len(value) > max_length:
            raise ToolValidationError(f"'{name}' depasse {max_length} caracteres")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum, maximum = spec.get("minimum"), spec.get("maximum")
        if minimum is not None and value < minimum:
            raise ToolValidationError(f"'{name}' doit etre >= {minimum}")
        if maximum is not None and value > maximum:
            raise ToolValidationError(f"'{name}' doit etre <= {maximum}")

    if isinstance(value, list):
        item_spec = spec.get("items")
        max_items = spec.get("maxItems")
        if max_items is not None and len(value) > max_items:
            raise ToolValidationError(f"'{name}' accepte au plus {max_items} elements")
        if isinstance(item_spec, dict):
            return [_validate_value(f"{name}[{i}]", item_spec, v) for i, v in enumerate(value)]

    return value
