"""Registre d'outils.

Ajouter une capacite a JARVIS = declarer une fonction et la decorer.  Le
cerveau n'a pas a etre modifie: il decouvre les outils disponibles a chaque
tour, avec leur description et leur schema.

    @registry.tool(
        name="get_sales",
        description="Ventes d'un restaurant pour une periode.",
        permission=PermissionLevel.READ,
        schema={...},
    )
    async def get_sales(ctx: ToolContext, *, branch: str, period: str) -> ToolResult:
        ...
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from jarvis_core.errors import ToolNotFoundError
from jarvis_core.llm.base import ToolSpec
from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.tools.base import ToolContext, ToolResult
from jarvis_core.tools.schema import validate_arguments

logger = logging.getLogger(__name__)

ToolHandler = Callable[..., Awaitable[ToolResult]]


@dataclass(frozen=True)
class RegisteredTool:
    """Un outil disponible pour le modele."""

    name: str
    description: str
    permission: PermissionLevel
    schema: dict[str, Any]
    handler: ToolHandler
    feature_flag: str = ""
    """Nom du flag (`gmail`, `calendar`...) qui conditionne l'exposition."""
    recipients_field: str = ""
    """Champ contenant les destinataires, pour l'evaluation de permission."""
    tags: tuple[str, ...] = field(default_factory=tuple)

    def to_spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description=self.description, input_schema=self.schema)


class ToolRegistry:
    """Collection d'outils, filtrable par feature flags."""

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}

    def tool(
        self,
        *,
        name: str,
        description: str,
        permission: PermissionLevel,
        schema: dict[str, Any] | None = None,
        feature_flag: str = "",
        recipients_field: str = "",
        tags: tuple[str, ...] = (),
    ) -> Callable[[ToolHandler], ToolHandler]:
        """Decorateur d'enregistrement."""

        def decorator(handler: ToolHandler) -> ToolHandler:
            if not inspect.iscoroutinefunction(handler):
                raise TypeError(f"L'outil '{name}' doit etre une coroutine (async def).")
            self.register(
                RegisteredTool(
                    name=name,
                    description=description,
                    permission=permission,
                    schema=schema or {"type": "object", "properties": {}},
                    handler=handler,
                    feature_flag=feature_flag,
                    recipients_field=recipients_field,
                    tags=tags,
                )
            )
            return handler

        return decorator

    def register(self, tool: RegisteredTool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Outil deja enregistre: {tool.name}")
        self._tools[tool.name] = tool
        logger.debug("outil enregistre: %s (palier %s)", tool.name, int(tool.permission))

    def get(self, name: str) -> RegisteredTool:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise ToolNotFoundError(
                f"outil inconnu: {name}",
                user_message="Je n'ai pas d'outil pour faire ca.",
            ) from exc

    def has(self, name: str) -> bool:
        return name in self._tools

    def all(self) -> list[RegisteredTool]:
        return list(self._tools.values())

    def available(self, features: dict[str, bool]) -> list[RegisteredTool]:
        """Outils exposables compte tenu des feature flags actifs."""
        return [
            tool
            for tool in self._tools.values()
            if not tool.feature_flag or features.get(tool.feature_flag, False)
        ]

    def specs(self, features: dict[str, bool]) -> list[ToolSpec]:
        return [tool.to_spec() for tool in self.available(features)]

    async def execute(
        self, name: str, arguments: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        """Valide les arguments puis execute l'outil.

        La validation est faite ici, jamais dans les handlers: un outil peut
        ainsi supposer que ses parametres sont conformes a son schema.
        """
        tool = self.get(name)
        cleaned = validate_arguments(tool.schema, arguments)
        return await tool.handler(context, **cleaned)

    def extract_recipients(self, name: str, arguments: dict[str, Any]) -> list[str]:
        """Extrait les destinataires d'un appel, pour la politique de permission."""
        tool = self.get(name)
        if not tool.recipients_field:
            return []
        raw = arguments.get(tool.recipients_field)
        if isinstance(raw, str):
            return [raw]
        if isinstance(raw, list):
            return [str(item) for item in raw]
        return []


#: Registre global peuple par `jarvis_core.tools.builtin`.
registry = ToolRegistry()
