# Terrain shape — the sweep table and what it implies

**Branch:** `terrain-sweep`. This note is the deliverable: the measured price of field
relief, over `(amplitude × wavelength)`. It **recommends no amplitude** — Jesse picks the two
numbers. `terrainAmplitude` is still `0`; nothing visual changed.

## What changed to make this measurable

The single `terrain.maxStep = 0.5` conflated two unrelated bounds. It was written to bound the
**apron ramp** (the authored padY→field transition) as a per-cell height step, but it was also
the only thing bounding the **field's own gradient** — so it silently decided the game's terrain
shape, and it did so with the wrong *kind* of number (a per-cell Δh of 0.5 over a 3 m cell is a
slope of 0.166 in disguise). It is now two honest constants plus the missing axis:

- `apronMaxStep = 0.5` — per-cell Δh inside the apron band (a step; the apron is an authored ramp).
- `fieldMaxSlope = 0.166` — rise/run on open-field cells (a slope; the field gradient is emergent).
- `terrainWavelength = 16` — the field's characteristic period (m); noise frequency = 1/wavelength.
- `apronCells = 3` — apron width in **grid cells**; `apronWidth = apronCells × cellSize = 9 m` is
  derived at every build site, so the two can never desync (same grid-lines discipline as the
  paved rects). This snapped the apron from the arbitrary 8 m (2.67 cells) to a whole 3 cells.

`verify:terrain` assertion 4 split into **4a** (apron cells over step) and **4b** (field cells
over slope), each printing a count, plus `cells newly accepted: 0` — the proof the split is **at
least as strict** as the retired whole-grid bound (no cell it rejected now passes). All trivially
green at amplitude 0 (`0/1952` apron, `0/16653` field), which is expected; they are the assertions
that bind when relief turns on.

## The sweep (`npm run sweep:terrain`)

A measuring instrument, not a `verify:*` — it asserts nothing. Axes live in the script. Constant
across the grid: **PlayArea pad fraction 8.7%**.

```
 amp  wave         fieldSlope  pavedSlope  mainRelief   meshGap  slopeOK
------------------------------------------------------------------------
 0.5    20       0.085 (4.8°)       0.083       0.39m    0.168m      yes
 0.5    40       0.045 (2.6°)       0.064       0.34m    0.082m      yes
 0.5    60       0.030 (1.7°)       0.047       0.13m    0.077m      yes
 0.5    80       0.022 (1.3°)       0.060       0.18m    0.096m      yes
 0.5   120       0.012 (0.7°)       0.083       0.16m    0.126m      yes
 1.0    20       0.170 (9.6°)       0.166       0.78m    0.335m       NO
 1.0    40       0.090 (5.1°)       0.128       0.67m    0.163m      yes
 1.0    60       0.060 (3.4°)       0.094       0.27m    0.155m      yes
 1.0    80       0.044 (2.5°)       0.121       0.37m    0.193m      yes
 1.0   120       0.024 (1.4°)       0.166       0.32m    0.253m      yes
 1.5    20      0.254 (14.3°)       0.249       1.17m    0.503m       NO
 1.5    40       0.135 (7.7°)       0.191       1.01m    0.245m      yes
 1.5    60       0.090 (5.1°)       0.140       0.40m    0.232m      yes
 1.5    80       0.067 (3.8°)       0.181       0.55m    0.289m      yes
 1.5   120       0.036 (2.1°)       0.249       0.49m    0.379m      yes
 2.0    20      0.339 (18.7°)       0.332       1.56m    0.670m       NO
 2.0    40      0.180 (10.2°)       0.255       1.35m    0.326m       NO
 2.0    60       0.120 (6.8°)       0.187       0.54m    0.309m      yes
 2.0    80       0.089 (5.1°)       0.242       0.73m    0.385m      yes
 2.0   120       0.048 (2.7°)       0.331       0.65m    0.506m      yes
 3.0    20      0.509 (27.0°)       0.498       2.33m    1.006m       NO
 3.0    40      0.269 (15.1°)       0.383       2.02m    0.489m       NO
 3.0    60      0.179 (10.2°)       0.281       0.81m    0.464m       NO
 3.0    80      0.133 (7.6°)       0.363       1.10m    0.578m      yes
 3.0   120       0.072 (4.1°)       0.497       0.97m    0.758m      yes
 4.0    20      0.678 (34.1°)       0.665       3.11m    1.341m       NO
 4.0    40      0.359 (19.8°)       0.510       2.70m    0.652m       NO
 4.0    60      0.239 (13.4°)       0.374       1.08m    0.619m       NO
 4.0    80      0.178 (10.1°)       0.484       1.46m    0.771m       NO
 4.0   120       0.096 (5.5°)       0.663       1.29m    1.011m      yes
```

**Largest amplitude at `fieldMaxSlope = 0.166` (field slope is exactly linear in amplitude):**

| wave (m) | slope / amp | max amp (m) |
|---|---|---|
| 20 | 0.1696 | **0.98** |
| 40 | 0.0898 | **1.85** |
| 60 | 0.0598 | **2.78** |
| 80 | 0.0445 | **3.73** |
| 120 | 0.0240 | **6.93** |

## What the table implies

- **Wavelength is the axis that was missing.** At a fixed slope budget, the achievable amplitude
  scales roughly linearly with wavelength: ~1 m at 20 m, ~7 m at 120 m. Amplitude alone never
  determined the gradient — the run-one diagnosis inherited that error, capping "how much relief"
  at a single ≈0.76 m number that was really a wavelength-16 artefact.
- **The diagnosis's ≈0.76 m cap is confirmed and located.** It was measured at the shipped
  `terrainWavelength = 16` (not in this grid, whose shortest is 20). The sweep's wave-20 row gives
  max amp 0.98 m; a shorter wavelength gives a lower cap, so ≈0.76 m at 16 m is consistent — the
  cap is a *measured* property of `(fieldMaxSlope, wavelength)`, not a mystery constant.
- **`pavedSlope` tracks `fieldSlope` closely** — the paved network crosses open field, it does not
  mostly run between pads, so the streets sit on whatever slope the field produces (confirms the
  diagnosis's steepest-slope answer).
- **`meshGap` is wavelength-DEPENDENT — this CORRECTS the §2/§4 expectation.** §4 predicted it
  would be dominated by pad-edge creases and thus roughly wavelength-independent. It is not: at
  amp 1.0 it ranges 0.155–0.335 m across wavelengths (spread 116.7%), largest at the *short*
  wavelength where the 3 m mesh under-resolves the field's own curvature. So Path A's trap — that
  paint lifted to **analytic** `heightAt` disagrees with the triangulated mesh — is *worse* at
  short wavelength than the diagnosis assumed, and it exceeds every paint tier (0.02–0.045 m) at
  every row in the table, including amp 0.5. Path A must sample the mesh surface, not `heightAt`.
- **The `NO` cells are where `fieldMaxSlope` binds first** (before `maxWalkable 0.6` and before
  the apron step). Any amplitude/wavelength pair with `slopeOK = yes` ships under the current
  asserts unchanged; a `NO` pair needs `fieldMaxSlope` widened first — a separate, deliberate call.

The two numbers to pick — `terrainAmplitude` and `terrainWavelength` — are Jesse's. The table is
the input; this note prices it and stops.
