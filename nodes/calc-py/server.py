"""Demo brAIn node: a tiny safe-arithmetic calculator.

Run with:
    cd nodes/calc-py
    python3.11 -m venv .venv && .venv/bin/pip install fastapi uvicorn ../../packages/python-sdk
    CALC_PY_TOKEN=letmein .venv/bin/uvicorn server:app --port 9001

Then in brAIn, spawn the node (the calc-py type is auto-discovered)
and publish on calc.request — the result lands on calc.result.
"""
from __future__ import annotations

import ast
import operator
from typing import Any

from fastapi import FastAPI

from brain_web import BrainNode, Message

app = FastAPI()
node = BrainNode(auth_token_env="CALC_PY_TOKEN")
node.attach(app)

# Restricted AST evaluator — supports + - * / // % ** and parentheses.
_OPS: dict[type, Any] = {
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


def _safe_eval(expr: str) -> float:
    tree = ast.parse(expr, mode="eval")

    def _go(n: ast.AST) -> float:
        if isinstance(n, ast.Expression):
            return _go(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return float(n.value)
        if isinstance(n, ast.BinOp):
            op = _OPS.get(type(n.op))
            if op is None:
                raise ValueError(f"operator not allowed: {type(n.op).__name__}")
            return op(_go(n.left), _go(n.right))
        if isinstance(n, ast.UnaryOp):
            op = _OPS.get(type(n.op))
            if op is None:
                raise ValueError(f"operator not allowed: {type(n.op).__name__}")
            return op(_go(n.operand))
        raise ValueError(f"node not allowed: {type(n).__name__}")

    return _go(tree)


@node.on("calc.request")
async def on_request(msg: Message) -> None:
    expr = str(msg.payload.get("content", "")).strip()
    try:
        result = _safe_eval(expr)
        await node.publish(
            "calc.result",
            f"{expr} = {result}",
            criticality=2,
            metadata={"expression": expr, "value": result},
        )
        await node.log("info", f"calc {expr} = {result}")
    except Exception as e:  # noqa: BLE001
        await node.publish(
            "calc.result",
            f"error: {e}",
            criticality=2,
            metadata={"expression": expr, "error": str(e)},
        )
        await node.log("warn", f"calc failed: {e}", {"expression": expr})
