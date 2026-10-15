# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Study-type presets (SPEC §6.5). They set *defaults* only; every value can be changed.

The labels shown to the user live in the frontend dictionary (``studyType.<id>``):
this table is data, consumed by the model setup now and by the planner later.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

__all__ = ["STUDY_TYPES", "StudyTypeId", "StudyTypePreset"]

StudyTypeId = Literal[
    "veicolo", "ala", "persona", "edificio_pianta", "edificio_prospetto", "generico"
]


class StudyTypePreset(BaseModel):
    id: StudyTypeId
    #: vertical = x-z plane (normal along y); horizontal = x-y plane (normal along z).
    plane: Literal["vertical", "horizontal"]
    #: Cut position as a fraction of the model's extent along the plane normal.
    depth_fraction: float
    ground: Literal["none", "fixed", "moving"]
    inlet_profile: Literal["uniform", "boundary_layer"]
    speed_ms: float
    reference_length: Literal["length_x", "chord", "frontal_height", "frontal_width", "height"]
    max_blockage: float


STUDY_TYPES: dict[str, StudyTypePreset] = {
    p.id: p
    for p in (
        StudyTypePreset(
            id="veicolo",
            plane="vertical",
            depth_fraction=0.5,
            ground="moving",
            inlet_profile="uniform",
            speed_ms=30,
            reference_length="length_x",
            max_blockage=0.08,
        ),
        StudyTypePreset(
            id="ala",
            plane="vertical",
            depth_fraction=0.4,
            ground="none",
            inlet_profile="uniform",
            speed_ms=15,
            reference_length="chord",
            max_blockage=0.05,
        ),
        StudyTypePreset(
            id="persona",
            plane="vertical",
            depth_fraction=0.5,
            ground="moving",
            inlet_profile="uniform",
            speed_ms=12,
            reference_length="frontal_height",
            max_blockage=0.08,
        ),
        StudyTypePreset(
            id="edificio_pianta",
            plane="horizontal",
            depth_fraction=1 / 3,
            ground="none",
            inlet_profile="uniform",
            speed_ms=10,
            reference_length="frontal_width",
            max_blockage=0.08,
        ),
        StudyTypePreset(
            id="edificio_prospetto",
            plane="vertical",
            depth_fraction=0.5,
            ground="fixed",
            inlet_profile="boundary_layer",
            speed_ms=10,
            reference_length="height",
            max_blockage=0.08,
        ),
        StudyTypePreset(
            id="generico",
            plane="vertical",
            depth_fraction=0.5,
            ground="none",
            inlet_profile="uniform",
            speed_ms=10,
            reference_length="frontal_height",
            max_blockage=0.05,
        ),
    )
}
