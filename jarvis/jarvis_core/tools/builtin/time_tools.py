"""Outils temporels et de calcul.

Le modele n'a le droit ni de calculer une date, ni de faire de l'arithmetique
de tete: il passe par ces outils, qui utilisent de vraies librairies.
"""

from __future__ import annotations

import ast
import operator
from typing import Any

from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.timeutils import format_datetime_fr, now, resolve_date_expression
from jarvis_core.tools.base import ToolContext, ToolResult
from jarvis_core.tools.registry import registry


@registry.tool(
    name="get_current_time",
    description=(
        "Donne la date et l'heure courantes dans le fuseau de l'utilisateur. "
        "A utiliser des qu'une question depend du moment present."
    ),
    permission=PermissionLevel.READ,
    schema={"type": "object", "properties": {}},
    tags=("temps",),
)
async def get_current_time(ctx: ToolContext) -> ToolResult:
    current = now(ctx.timezone)
    return ToolResult.success(
        summary=f"Il est {format_datetime_fr(current, ctx.timezone)} ({ctx.timezone}).",
        data={"iso": current.isoformat(), "timezone": ctx.timezone},
    )


@registry.tool(
    name="resolve_date",
    description=(
        "Transforme une expression temporelle francaise ou anglaise en dates precises. "
        "Exemples: 'demain', 'vendredi prochain', 'la semaine passee', 'dans 3 jours'. "
        "A appeler avant toute recherche portant sur une periode."
    ),
    permission=PermissionLevel.READ,
    schema={
        "type": "object",
        "properties": {
            "expression": {
                "type": "string",
                "description": "L'expression temporelle a resoudre.",
                "maxLength": 100,
            }
        },
        "required": ["expression"],
    },
    tags=("temps",),
)
async def resolve_date(ctx: ToolContext, *, expression: str) -> ToolResult:
    try:
        window = resolve_date_expression(expression, ctx.timezone)
    except ValueError:
        return ToolResult.failure(
            summary=(
                f"Je n'arrive pas a interpreter '{expression}'. "
                "Demande une precision a l'utilisateur, ne devine pas."
            ),
            data={"expression": expression},
        )
    return ToolResult.success(
        summary=(
            f"'{window.label}' correspond a la periode du {window.start.isoformat()} "
            f"au {window.end.isoformat()} ({ctx.timezone})."
        ),
        data=window.as_dict(),
    )


_OPERATORS: dict[type[ast.operator | ast.unaryop], Any] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _safe_eval(node: ast.AST) -> float:
    """Evalue une expression arithmetique sans jamais executer de code arbitraire."""
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("seuls les nombres sont acceptes")
        return float(node.value)
    if isinstance(node, ast.BinOp):
        func = _OPERATORS.get(type(node.op))
        if func is None:
            raise ValueError("operateur non supporte")
        return func(_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp):
        func = _OPERATORS.get(type(node.op))
        if func is None:
            raise ValueError("operateur non supporte")
        return func(_safe_eval(node.operand))
    raise ValueError("expression non supportee")


@registry.tool(
    name="calculate",
    description=(
        "Evalue une expression arithmetique (+, -, *, /, %, puissance, parentheses). "
        "A utiliser pour tout calcul de montant, de taxe ou de pourcentage: "
        "ne calcule jamais de tete."
    ),
    permission=PermissionLevel.READ,
    schema={
        "type": "object",
        "properties": {
            "expression": {
                "type": "string",
                "description": "Expression arithmetique, ex: '1250.50 * 1.14975'.",
                "maxLength": 200,
            }
        },
        "required": ["expression"],
    },
    tags=("calcul",),
)
async def calculate(ctx: ToolContext, *, expression: str) -> ToolResult:
    cleaned = expression.replace(",", ".").replace("×", "*").replace("÷", "/").replace(" ", "")
    try:
        tree = ast.parse(cleaned, mode="eval")
        value = _safe_eval(tree)
    except (SyntaxError, ValueError, ZeroDivisionError, OverflowError) as exc:
        return ToolResult.failure(
            summary=f"Calcul impossible pour '{expression}': {exc}.",
            data={"expression": expression},
        )
    rounded = round(value, 4)
    display = int(rounded) if rounded == int(rounded) else rounded
    return ToolResult.success(
        summary=f"{expression} = {display}",
        data={"expression": expression, "result": value},
    )
