# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Test 5: the contracts have the same fields, of the same types, on both sides (SPEC §5).

The Pydantic models give their JSON schema; ``frontend/src/lib/types.ts`` is
read with a small parser for the plain style it is written in (one
``export type Name = {...}`` per model, ``field: type`` per line). Both sides
are reduced to the same notation -- ``number``, ``string``, ``array<T>``,
``tuple<A,B>``, literal sets, model names, unions -- and compared.

SimulationResult joins the list in Phase 5.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from gdv.geometry import profile
from gdv.geometry.sketch import params as sketch_params
from gdv.physics import fluids, planner

TYPES_TS = Path(__file__).resolve().parents[1] / "frontend" / "src" / "lib" / "types.ts"

CONTRACTS: list[type[BaseModel]] = [
    profile.Loop,
    profile.SplineLoop,
    profile.SplineData,
    profile.Section3DSource,
    profile.DrawingSource,
    sketch_params.SketchParams,
    profile.PhotoSource,
    profile.EditorSource,
    profile.ProfileDraft,
    profile.Profile2D,
    profile.Issue,
    profile.ValidationReport,
    planner.Domain,
    planner.ReferenceLength,
    planner.CaseSetup,
    planner.PlanTexts,
    planner.CasePlan,
    fluids.FluidProperties,
]

# --- Python side ---------------------------------------------------------------------


def py_type(schema: dict[str, Any]) -> str:
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "const" in schema:
        return f"lit:{schema['const']}"
    if "enum" in schema:
        return "lit:" + "|".join(sorted(map(str, schema["enum"])))
    for key in ("anyOf", "oneOf"):
        if key in schema:
            return union(py_type(s) for s in schema[key])
    kind = schema.get("type")
    if kind == "array":
        if "prefixItems" in schema:
            return "tuple<" + ",".join(py_type(s) for s in schema["prefixItems"]) + ">"
        return f"array<{py_type(schema['items'])}>"
    if kind == "object":
        return "record"
    if kind == "integer":
        return "number"
    return str(kind)


def union(parts) -> str:
    flat: set[str] = set()
    for p in parts:
        flat.update(p[6:-1].split(";") if p.startswith("union<") else [p])
    # Literal members merge into one set, as TypeScript writes them.
    lits = sorted(m for f in flat if f.startswith("lit:") for m in f[4:].split("|"))
    rest = sorted(f for f in flat if not f.startswith("lit:"))
    members = rest + ([f"lit:{'|'.join(lits)}"] if lits else [])
    return members[0] if len(members) == 1 else "union<" + ";".join(sorted(members)) + ">"


def python_fields(model: type[BaseModel]) -> dict[str, str]:
    schema = model.model_json_schema(ref_template="#/$defs/{model}")
    return {name: py_type(prop) for name, prop in schema["properties"].items()}


# --- TypeScript side -----------------------------------------------------------------


def ts_declarations(text: str) -> dict[str, str]:
    """``export type Name = ...`` bodies, by name (comments removed)."""
    text = re.sub(r"//[^\n]*", "", text)
    out = {}
    parts = re.split(r"\bexport type (\w+)\s*=", text)
    for name, body in zip(parts[1::2], parts[2::2], strict=True):
        out[name] = body.split("\nexport ")[0].strip()
    return out


def split_top(text: str, sep: str) -> list[str]:
    depth, current, out = 0, "", []
    for ch in text:
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth -= 1
        if ch == sep and depth == 0:
            out.append(current)
            current = ""
        else:
            current += ch
    out.append(current)
    return [p.strip() for p in out if p.strip()]


def ts_type(text: str, aliases: dict[str, str]) -> str:
    t = text.strip()
    members = split_top(t.lstrip("|").strip(), "|")
    if len(members) > 1:
        return union(ts_type(m, aliases) for m in members)
    if t.endswith("[]"):
        return f"array<{ts_type(t[:-2], aliases)}>"
    if t.startswith("(") and t.endswith(")"):
        return ts_type(t[1:-1], aliases)
    if t.startswith("["):
        return "tuple<" + ",".join(ts_type(m, aliases) for m in split_top(t[1:-1], ",")) + ">"
    if t.startswith("'"):
        return f"lit:{t.strip(chr(39))}"
    if t.startswith("Record<"):
        return "record"
    if t in ("string", "number", "boolean", "null"):
        return t
    if t in aliases and not aliases[t].startswith("{"):
        return ts_type(aliases[t], aliases)
    return t


def ts_fields(name: str, declarations: dict[str, str]) -> dict[str, str]:
    body = declarations[name]
    assert body.startswith("{"), f"{name} non è un tipo oggetto in types.ts"
    inner = body[1 : body.rindex("}")]
    fields = {}
    for line in split_top(inner.replace("\n", ";"), ";"):
        key, _, value = line.partition(":")
        fields[key.strip().rstrip("?")] = ts_type(value, declarations)
    return fields


@pytest.fixture(scope="module")
def declarations() -> dict[str, str]:
    return ts_declarations(TYPES_TS.read_text(encoding="utf-8"))


@pytest.mark.parametrize("model", CONTRACTS, ids=lambda m: m.__name__)
def test_5_same_fields_and_types(model, declarations):
    py = python_fields(model)
    ts = ts_fields(model.__name__, declarations)
    assert sorted(ts) == sorted(py), f"campi diversi per {model.__name__}"
    for field, kind in py.items():
        assert ts[field] == kind, f"{model.__name__}.{field}: TS {ts[field]} ≠ Python {kind}"


def test_5_the_parser_reads_what_it_should(declarations):
    assert ts_type("(SplineLoop | null)[]", declarations) == "array<union<SplineLoop;null>>"
    assert ts_type("Point2[]", declarations) == "array<tuple<number,number>>"
    assert ts_type("'a' | 'b'", declarations) == "lit:a|b"
    assert python_fields(profile.Issue)["code"].startswith("lit:no_loops|")
