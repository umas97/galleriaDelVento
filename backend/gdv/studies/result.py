# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""``SimulationResult``, the third contract (SPEC §5, §11.1), and the study around it.

A result carries its conditions (SPEC §2.3): the ``CaseSetup`` as it ran -- the
profile, and for a model's section the cut in ``profile.source`` -- and the
``CasePlan`` with both Reynolds numbers, the reference length and the grid.
The bulky parts stay in files next to ``studio.json`` and the result only
points at them (paths relative to the study's folder):

* ``storia.npz``   ``step``, ``cd``, ``cl``, ``cm`` -- one sample every 8 steps;
* ``campi.npz``    the time-averaged fields as float16, shape (ny, nx), row 0
  at the bottom of the chamber, *normalised*: ``u``, ``v`` on the speed V,
  ``cp``, ``vorticity`` on V / L_ref; the real value is ``stored · scale``
  (:class:`FieldRef`). ``solid`` is the body's mask. Normalised, because
  float16 stops at 65 504 and a vorticity in 1/s can go beyond it;
* ``contorno.npz`` ``xc``, ``s``, ``upper``, ``cp`` and the chamber position
  ``x``, ``y`` (cells) of each sampled point of the outline.

A study is one result (``single``) or a series of them (``series``, SPEC
§11.3). A series point lives in ``punti/<k>/`` with the same files; points are
written as they finish, so a crash loses nothing that was done.

A result of the 3D tunnel (SPEC §24.2 #7) is the same contract's 3D variant,
:class:`SimulationResult3D` (``dimension = "3d"``; a 2D result says "2d", or
nothing in the files written before): ``CaseSetup3D`` and ``CasePlan3D``, the
whole body's coefficients, and

* ``storia.npz``   ``step``, ``cd``, ``cl``, ``cs`` (corrected, SPEC §24.6);
* ``campi.npz``    ``u``, ``v``, ``w`` on V and ``cp``, float16, shape
  (nz, ny, nx), x fastest, and ``solid`` (the voxels).

It has no contour; its pictures are the view as the user left it, the
longitudinal plane and the Cp on the surface. A 3D study is always single.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, model_validator

from .. import __version__
from ..physics.coefficients import Coefficients, Coefficients3D, Forces, Forces3D
from ..physics.planner import CasePlan, CaseSetup
from ..physics.planner3d import CasePlan3D, CaseSetup3D

__all__ = [
    "SCHEMA_VERSION",
    "VIEW_NAMES",
    "ContourCpRef",
    "ContourData",
    "FieldRef",
    "FieldRef3D",
    "HistoryData",
    "HistoryData3D",
    "MeanData",
    "PointUpload",
    "PointUpload3D",
    "AnyPointUpload",
    "AnyResult",
    "SeriesParameter",
    "SeriesSpec",
    "SimulationResult",
    "SimulationResult3D",
    "Study",
    "StudyMeta",
    "StudyPoint",
    "StudySummary",
    "TimeSeriesRef",
    "ViewName",
]

SCHEMA_VERSION = 1

#: The instantaneous pictures saved with a result (SPEC §11.2): speed, Cp,
#: vorticity, smoke if it was on; for a model's section, the mini-scene with the
#: plane. A 3D result: the view as it was, the longitudinal plane, Cp on the surface.
ViewName = Literal["velocita", "cp", "vorticita", "fumo", "modello", "vista", "piano", "superficie"]
VIEW_NAMES: tuple[str, ...] = (
    "velocita", "cp", "vorticita", "fumo", "modello", "vista", "piano", "superficie",
)  # fmt: skip
Status = Literal["converged", "provisional", "unstable"]
SeriesParameter = Literal["angle", "speed", "depth"]


class TimeSeriesRef(BaseModel):
    file: str
    samples: int
    #: Steps between two samples.
    every: int


class FieldRef(BaseModel):
    file: str
    key: str
    name: Literal["u", "v", "cp", "vorticity"]
    #: Unit of the real value, which is ``stored · scale``.
    unit: str
    scale: float
    nx: int
    ny: int
    #: Cell size, metres; cell (i, j) has its centre at ((i + ½)·dx, (j + ½)·dx).
    dx: float
    #: Samples averaged on the GPU (one every 8 steps).
    samples: int


class FieldRef3D(BaseModel):
    """A mean field of a 3D result: (nz, ny, nx), x fastest; real value ``stored · scale``."""

    file: str
    key: str
    name: Literal["u", "v", "w", "cp"]
    unit: str
    scale: float
    nx: int
    ny: int
    nz: int
    #: Cell size, metres; cell (i, j, k) has its centre at ((i, j, k) + ½)·dx in the chamber.
    dx: float
    samples: int


class ContourCpRef(BaseModel):
    file: str
    points: int
    #: Cp against x/c (a chord reference) or along the perimeter.
    chord: bool


class SimulationResult(BaseModel):
    """One case as it ran, with its numbers and where its data are (SPEC §11.1)."""

    model_config = ConfigDict(allow_inf_nan=False)

    dimension: Literal["2d"] = "2d"
    case: CaseSetup
    plan: CasePlan
    status: Status
    coefficients: Coefficients
    forces_real: Forces
    history: TimeSeriesRef
    fields: list[FieldRef]
    contour_cp: ContourCpRef
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    app_version: str = __version__
    schema_version: int = SCHEMA_VERSION


class SimulationResult3D(BaseModel):
    """One case of the 3D tunnel as it ran (SPEC §24.2 #7): the contract's 3D variant."""

    model_config = ConfigDict(allow_inf_nan=False)

    dimension: Literal["3d"] = "3d"
    case: CaseSetup3D
    plan: CasePlan3D
    status: Status
    coefficients: Coefficients3D
    forces_real: Forces3D
    history: TimeSeriesRef
    fields: list[FieldRef3D]
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    app_version: str = __version__
    schema_version: int = SCHEMA_VERSION


def _dimension(value: Any) -> str:
    """Files written before the 3D tunnel have no ``dimension``: they are 2D."""
    found = value.get("dimension") if isinstance(value, dict) else getattr(value, "dimension", None)
    return "3d" if found == "3d" else "2d"


AnyResult = Annotated[
    Annotated[SimulationResult, Tag("2d")] | Annotated[SimulationResult3D, Tag("3d")],
    Discriminator(_dimension),
]


class StudyPoint(BaseModel):
    """A result in a study; for a series, with the value of the swept parameter."""

    #: Incidence (°), speed (m/s) or depth (fraction) for a series point; None otherwise.
    value: float | None
    result: AnyResult
    #: Steps the solver ran, from rest.
    steps: int
    elapsed_s: float
    views: list[ViewName]


class SeriesSpec(BaseModel):
    parameter: SeriesParameter
    #: The planned values; the points done are the study's points.
    values: list[float] = Field(min_length=1, max_length=200)
    state: Literal["running", "done", "stopped"]


class Study(BaseModel):
    """``studi/<uuid>/studio.json`` (SPEC §11.2, §14.1)."""

    id: str
    name: str
    notes: str
    kind: Literal["single", "series"]
    series: SeriesSpec | None
    #: The library profile simulated (a live section is saved as one first), if any.
    profile_id: str | None
    profile_name: str
    #: For a model's section (and a depth series): the model.
    model_id: str | None
    model_name: str | None
    points: list[StudyPoint]
    created_at: datetime
    updated_at: datetime
    schema_version: int = SCHEMA_VERSION


class StudySummary(BaseModel):
    """One row of the studies list."""

    id: str
    name: str
    kind: Literal["single", "series"]
    parameter: SeriesParameter | None
    state: Literal["running", "done", "stopped"] | None
    points: int
    planned: int
    #: Single study: its status; series: converged only if every point converged.
    status: Status | None
    profile_id: str | None
    profile_name: str
    model_id: str | None
    model_name: str | None
    #: "3d": a study of the 3D tunnel.
    dimension: Literal["2d", "3d"]
    #: Single study: mean Cd and Cl (None for a series or without numbers).
    cd: float | None
    cl: float | None
    reynolds: str
    created_at: datetime
    size_bytes: int
    has_thumbnail: bool
    read_only: bool


# --- what the interface sends -------------------------------------------------------


class StudyMeta(BaseModel):
    """The study as the interface creates it (its points come separately)."""

    name: str = Field(min_length=1, max_length=200)
    notes: str = Field(default="", max_length=20_000)
    profile_id: str | None = None
    profile_name: str = Field(max_length=200)
    model_id: str | None = None
    model_name: str | None = None
    series: SeriesSpec | None = None


class HistoryData(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    every: int = Field(gt=0)
    step: list[int]
    cd: list[float]
    cl: list[float]
    cm: list[float]

    @model_validator(mode="after")
    def _same_length(self) -> HistoryData:
        if not len(self.step) == len(self.cd) == len(self.cl) == len(self.cm):
            raise ValueError("serie storiche di lunghezza diversa")
        return self


class HistoryData3D(BaseModel):
    """Cd, Cl and the side force Cs of the 3D tunnel, corrected (SPEC §24.6)."""

    model_config = ConfigDict(allow_inf_nan=False)

    every: int = Field(gt=0)
    step: list[int]
    cd: list[float]
    cl: list[float]
    cs: list[float]

    @model_validator(mode="after")
    def _same_length(self) -> HistoryData3D:
        if not len(self.step) == len(self.cd) == len(self.cl) == len(self.cs):
            raise ValueError("serie storiche di lunghezza diversa")
        return self


class ContourData(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    chord: bool
    xc: list[float]
    s: list[float]
    upper: list[bool]
    cp: list[float]
    #: Chamber position of each point, cells.
    x: list[float]
    y: list[float]

    @model_validator(mode="after")
    def _same_length(self) -> ContourData:
        n = len(self.xc)
        if not all(len(v) == n for v in (self.s, self.upper, self.cp, self.x, self.y)):
            raise ValueError("punti del contorno di lunghezza diversa")
        return self


class MeanData(BaseModel):
    """The averaged fields that come as binary: how many samples, and ρ∞ over them."""

    model_config = ConfigDict(allow_inf_nan=False)

    samples: int = Field(ge=1)
    rho_inf: float = Field(gt=0.0)


class PointUpload(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    dimension: Literal["2d"] = "2d"
    value: float | None = None
    case: CaseSetup
    plan: CasePlan
    status: Status
    coefficients: Coefficients
    history: HistoryData
    contour: ContourData
    #: None when averaging had not started: the result has no fields.
    mean: MeanData | None
    steps: int = Field(ge=0)
    elapsed_s: float = Field(ge=0.0)


class PointUpload3D(BaseModel):
    """A finished 3D case as the interface sends it; the mean field comes as binary
    (``studies/fields.py``: sums of δρ, ux, uy, uz per cell, then the voxels)."""

    model_config = ConfigDict(allow_inf_nan=False)

    dimension: Literal["3d"] = "3d"
    value: None = None
    case: CaseSetup3D
    plan: CasePlan3D
    status: Status
    coefficients: Coefficients3D
    history: HistoryData3D
    mean: MeanData | None
    steps: int = Field(ge=0)
    elapsed_s: float = Field(ge=0.0)


AnyPointUpload = Annotated[
    Annotated[PointUpload, Tag("2d")] | Annotated[PointUpload3D, Tag("3d")],
    Discriminator(_dimension),
]
