# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
"""Air and water as functions of temperature (SPEC §9.1, test 19).

Air is an ideal gas at 101 325 Pa with Sutherland's viscosity. The reference
point of Sutherland's law is taken at 20 °C, so that the SPEC's anchor values
(ρ = 1.204 kg/m³, ν = 1.516·10⁻⁵ m²/s) come out exactly; with S = 110.4 K the
law then matches the usual tables at 0 and 40 °C within 0.2%.

Water comes from a table (IAPWS values at 1 atm), interpolated linearly in
density and in the logarithm of the viscosity, which is close to exponential
in temperature.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel

__all__ = ["FLUID_RANGES", "Fluid", "FluidProperties", "properties"]

Fluid = Literal["aria", "acqua"]

#: Temperatures a case may use, °C (SPEC §9.1).
FLUID_RANGES: dict[str, tuple[float, float]] = {"aria": (-20.0, 50.0), "acqua": (5.0, 40.0)}

P_ATM = 101_325.0
R_AIR = 287.05  # J/(kg K), dry air
GAMMA_AIR = 1.4
T0 = 273.15
SUTHERLAND_S = 110.4  # K
#: Dynamic viscosity of air at the reference temperature T_REF.
MU_REF = 1.8254e-5  # Pa s
T_REF = 293.15  # K

# °C, kg/m³, Pa·s, m/s (speed of sound)
_WATER = (
    (0.0, 999.84, 1.7914e-3, 1402.4),
    (5.0, 999.97, 1.5182e-3, 1426.2),
    (10.0, 999.70, 1.3059e-3, 1447.3),
    (15.0, 999.10, 1.1375e-3, 1465.9),
    (20.0, 998.21, 1.0016e-3, 1482.3),
    (25.0, 997.05, 0.8900e-3, 1497.0),
    (30.0, 995.65, 0.7972e-3, 1509.2),
    (35.0, 994.03, 0.7191e-3, 1519.8),
    (40.0, 992.22, 0.6527e-3, 1528.9),
    (45.0, 990.21, 0.5961e-3, 1536.4),
    (50.0, 988.03, 0.5465e-3, 1542.6),
)


class FluidProperties(BaseModel):
    fluid: Fluid
    temperature_c: float
    density: float  # kg/m³
    viscosity: float  # dynamic, Pa s
    kinematic_viscosity: float  # m²/s
    speed_of_sound: float  # m/s


def _air(temperature_c: float) -> tuple[float, float, float]:
    t = temperature_c + T0
    rho = P_ATM / (R_AIR * t)
    mu = MU_REF * (t / T_REF) ** 1.5 * (T_REF + SUTHERLAND_S) / (t + SUTHERLAND_S)
    return rho, mu, math.sqrt(GAMMA_AIR * R_AIR * t)


def _water(temperature_c: float) -> tuple[float, float, float]:
    rows = _WATER
    if not rows[0][0] <= temperature_c <= rows[-1][0]:
        raise ValueError(f"temperatura dell'acqua fuori tabella: {temperature_c} °C")
    for lo, hi in zip(rows, rows[1:], strict=False):
        if temperature_c <= hi[0]:
            a = (temperature_c - lo[0]) / (hi[0] - lo[0])
            rho = lo[1] + a * (hi[1] - lo[1])
            mu = math.exp(math.log(lo[2]) + a * (math.log(hi[2]) - math.log(lo[2])))
            c = lo[3] + a * (hi[3] - lo[3])
            return rho, mu, c
    raise AssertionError("unreachable")


def properties(fluid: Fluid, temperature_c: float) -> FluidProperties:
    rho, mu, c = (_air if fluid == "aria" else _water)(temperature_c)
    return FluidProperties(
        fluid=fluid,
        temperature_c=temperature_c,
        density=rho,
        viscosity=mu,
        kinematic_viscosity=mu / rho,
        speed_of_sound=c,
    )
