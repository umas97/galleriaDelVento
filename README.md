# galleriaDelVento

A real-time 2D wind tunnel for sections of 3D models, photographed sketches and 2D profiles.
The flow is solved on the GPU (Lattice Boltzmann D2Q9 in WebGL2) inside a local desktop window;
everything runs offline on `127.0.0.1`. The user interface is in Italian.

The full specification is in [`docs/SPEC.md`](docs/SPEC.md) (Italian) and is the project's
source of truth.

---

## Installation

```sh
./install.sh      # current user only, no sudo; running it again updates
./uninstall.sh    # removes command, menu entry and icons; data stays unless you say "sì"
```

`install.sh` checks the prerequisites (if something is missing it prints the exact command and
stops: it never installs system packages), prepares the Python environment with `uv`, then
installs:

- the command `~/.local/bin/galleriadelvento`;
- the icons in `~/.local/share/icons/hicolor/{48x48,128x128,256x256,scalable}/apps/`;
- the menu entry `~/.local/share/applications/galleriadelvento.desktop`, whose `StartupWMClass`
  is the window's identity: it is what gives the dock the right icon and name.

### The window

The program opens in a window of its own, with no address bar or tabs: a Chromium-family
browser in application mode, with a dedicated profile. Browsers are looked up in this order:
`chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `brave-browser`,
`microsoft-edge`, then their Flatpaks; `--browser PATH` or `GDV_BROWSER` force one. Without any
of them the default browser opens a tab and the interface explains why (the wind tunnel itself
needs WebGL2 with `EXT_color_buffer_float`). No browser is ever installed.

Data lives in `~/.local/share/galleriadelvento/`, logs in `~/.local/state/galleriadelvento/logs/`.

## Usage

```sh
galleriadelvento                  # program + window (what the menu entry runs)
galleriadelvento --no-window      # server only: development, SSH, scripts
```

Launching the command again does not start a second instance: it asks the running one to show
its window and exits. Closing the window closes the program; "Esci" in the interface does the
same.

### Settings, guide, shortcuts

"Impostazioni" in the header holds the persistent defaults (speed unit, fluid and temperature,
resolution, colour maps, CSV separator, steps per frame, reference length along the depth) in
`~/.config/galleriadelvento/config.json`, and shows how much space the library takes. "Guida",
or the `?` key anywhere, opens a side panel that explains every symbol, formula, chart, colour
and state, and lists the keyboard and mouse shortcuts; the small `?` next to a number or a chart
opens it at that entry. The theme follows the system (light or dark); the colour maps of the
flow are the same in both.

In the tunnel the view zooms and pans while the flow runs: wheel to zoom about the pointer, drag
the fluid (or use the middle button) to move, `+`/`-` to zoom, `0` or a double click on the
fluid for the whole chamber. The zoom never touches the simulation. The model's mini-scene stays
free during a series and can be enlarged over the tunnel.

### The 3D tunnel

"Galleria 3D" on a model's setup screen opens the whole model in a coarse 3D tunnel (D3Q19
Lattice Boltzmann in WebGPU compute shaders, half a million to four million cells): smoke from a
movable rake, particles, a cut plane coloured by speed or Cp, and Cp on the model's surface, seen
from a free camera (drag to orbit, right button or Shift to pan, wheel to zoom, double click to
go back). Speed, fluid, floor, resolution and the model's yaw and pitch restart the flow; the
views and the camera never touch it. The body's walls sit where its surface really is inside
each cell (interpolated bounce-back), so parts thinner than a cell still exist for the flow; key
7 shows the body as cubes, as the grid sees it. On the right: Cd, Cl and the side force Cs of the
whole body, corrected for the chamber's blockage, with the forces in newtons; «Salva studio»
keeps them with the 3D mean field (exported as VTK for ParaView), three pictures and a PDF
report, and 3D studies compare with each other. It needs WebGPU (Chrome on this machine has
it): without, the page says so and the rest of the program works as before.

### Studies and exports

"Salva studio" in the tunnel stores the current case with its conditions, the time-averaged
fields and a few pictures; a series runs the same case over a range of incidences, speeds or
section depths. Every export is a download: CSV (history, Cp along the contour, series points,
`;` and decimal comma by default), VTK, JSON, DXF/SVG of the profile, and a PDF report printed
by the same Chrome the window uses (headless, no network).

The VTK files open in ParaView (`sudo apt install paraview`, not a dependency): the `.vti` holds
the mean fields on the cell centres of the chamber (velocity in m/s, Cp, pressure in Pa,
vorticity in 1/s, the body's mask), the `.vtp` the outline with its mean Cp. In ParaView, open
the file, press "Apply", choose the array to colour by; "Glyph" on `velocita_m_s` draws arrows.
The conditions of the case are in a comment at the top of each file.

## Development

Requires [`uv`](https://docs.astral.sh/uv/) and, for the interface only, Node.

```sh
uv sync                                   # dependencies, including the dev group
uv run python packaging/make_icons.py     # placeholder icons (already done by the scaffold)
uv run pytest -q                          # tests
uv run ruff check . && uv run ruff format --check .

# interface: server without a window on a fixed port, Vite with hot reload
GDV_PORT=8853 uv run galleriadelvento --no-window
cd frontend && npm install && npm run dev  # http://localhost:5173
npm run build                              # writes into backend/gdv/static/
npm test                                   # vitest (pure logic)
```

`uv run pytest` also runs the browser end-to-end tests (`frontend/tests/e2e/`, playwright-core
driving the **system** Chrome, no browser download) when Chrome, Node and a frontend build are
present, and skips them saying why otherwise. Test fixtures are all synthetic, generated by the
tests (`tests/synthetic.py`).

Benchmarks of SPEC §17 live in `tests/bench/` and are run by hand:

```sh
uv run python tests/bench/bench_startup.py  # start-up to a drawn window <= 3 s, backend RAM <= 200 MB
uv run python tests/bench/bench_import.py   # 1 M-triangle STL import, target <= 5 s
uv run python tests/bench/bench_sketch.py   # sketch pipeline, <= 400 ms per update
cd frontend && node tests/bench/slicer.bench.mjs   # section index and cut in the worker, 1 M triangles
cd frontend && node tests/bench/tunnel.bench.mjs   # tunnel steps/s and fps on the real GPU
cd frontend && node tests/bench/series.bench.mjs   # an 11-incidence series, <= 7 min
cd frontend && node tests/bench/tunnel3d.bench.mjs  # 3D solver steps/s at the presets (WebGPU)
cd frontend && node tests/bench/gallery3d.bench.mjs # 3D tunnel with every view: steps/s and fps, >= 30 fps at Normale
cd frontend && node tests/bench/voxelize.bench.mjs  # voxels of a 1 M-triangle model, <= 2 s
uv run python tests/bench/bench_taumin3d.py         # smallest stable tau of the 3D solver
```

GPU and timing numbers depend on the power profile: measure on mains power, not in
"power saver" (on battery the Iris Xe and the CPU run at a fraction of their clock, and the
SwiftShader end-to-end tests slow down accordingly).

Some algorithms exist twice, in Python and in TypeScript (profile validation and the automatic
repair of sections, later the solid mask): `tests/crosscheck.py` runs the TypeScript side through
vitest on cases generated by pytest and compares the two (`frontend/tests/crosscheck.test.ts`).

## Layout

```
backend/gdv/
  __main__.py        command line
  runtime.py         start-up and shutdown: lock, server, window, signals
  config.py          XDG folders and process options (environment, never written)
  settings.py        the user's persistent settings (config.json), validated per key
  server.py          local HTTP server (127.0.0.1 only), base API, CSP, error handlers
  security.py        who may talk to the server (Host/Origin)
  window.py          the application window (and Chrome's offline flags)
  single_instance.py one program at a time
  safety.py          the write guard: nothing is written outside the app's folders
  errors.py          errors for the user (Italian message + technical details)
  api/               FastAPI routers, one per area
  library/           the on-disk library: models, 2D profiles, imported drawings, sketch photos
  geometry/          STL/OBJ import and repairs, placement, binary mesh format; the Profile2D
                     contract, its validation and repair; SVG/DXF import, DXF/SVG export;
                     raster2d.py, the reference mask of the solver; sketch/, the photo of a
                     hand sketch -> profile (sheet, thresholding, outline; OpenCV)
  physics/           fluid properties, the planners (CaseSetup -> CasePlan, and the 3D
                     tunnel's CaseSetup3D -> CasePlan3D), real forces
  studies/           SimulationResult and studies on disk, mean fields, CSV/VTK exports,
                     comparison, the PDF report (headless Chrome)
  lattice.py         D2Q9 constants and MRT matrices, the single source of the shader's ones
  lattice3d.py       the same for D3Q19 (the 3D tunnel)
  static/            the interface served by the server (built from frontend/)
frontend/src/
  pages/             screens (Library, ModelSetup, Section, ProfileEditor, Tunnel, Tunnel3D, Study,
                     Compare, Report, ...)
  sim2d/             the GPU solver (WebGL2 shaders), mask, views, forces, series, streamlines
  sim3d/             the 3D tunnel: D3Q19 solver in WebGPU compute shaders (WGSL written out
                     from the generated constants), voxels of the model (in a worker), its own
                     small WebGPU renderer (field texture, cut plane, surface Cp, smoke,
                     particles), the orbit camera and the frame loop
  tunnel/            the tunnel screen (conditions, results, top bar), saving studies, series
  study/             how a saved result reads: conditions, coefficients, charts, fields
  charts/            uPlot charts (coefficient history, Cp on the contour, probes, curves)
  section/           live sections: the slicer and its Web Worker
  sketch/            the sketch wizard's pieces: image overlay, previews, click geometry
  profile/           2D geometry: validation, repair (Clipper2), splines, fitting, measures
  editor/            the profile editor's document (undo/redo, symmetric mode) and canvas
  scene3d/           three.js / react-three-fiber scene of a model
  components/        shared UI (dialogs, errors, import flow, tooltips)
  guide/             the guide panel (symbols, formulas, charts, shortcuts) and its index
  lib/               API client, types mirroring the backend, binary mesh parser, settings,
                     theme
  i18n/it.ts         every user-visible string (it.guide.ts: the guide's texts, spread in)
packaging/           icons and their generator
scripts/             gen_lattice_ts.py: writes frontend/src/sim2d/lattice.generated.ts and
                     frontend/src/sim3d/lattice3d.generated.ts
tests/               pytest; tests/reference/ the Numba reference solvers (2D and 3D);
                     tests/bench/ for the SPEC §17 measurements (slow physics validation:
                     pytest -m slow)
docs/SPEC.md         the specification
```

User files are never modified: imports are uploads (the backend receives bytes, never a path),
the library keeps an untouched copy (`originale.*` for models, `disegni/<sha>.svg|dxf` for
drawings, `foto/<sha>.jpg|png|webp` for sketch photos) and writes only derived files next to
it. Exports are browser downloads.

## Dependencies

All permissive licences, compatible with GPL-3.0-or-later.

| Package | Licence | Why |
|---|---|---|
| fastapi, uvicorn | MIT, BSD-3 | local HTTP server (scaffold) |
| numpy | BSD-3 | all mesh arithmetic |
| scipy | BSD-3 | sparse graphs (components, normal orientation, the ends of an open stroke), smoothing splines of sketch outlines |
| trimesh | MIT | ASCII STL and OBJ parsing (binary STL is read directly with numpy) |
| fast-simplification | MIT | decimated view mesh above 500k triangles |
| python-multipart | Apache-2.0 | listed in the SPEC for uploads; mesh uploads stream the raw body |
| shapely | BSD-3 | validity of 2D profiles, and their repair (`make_valid` + union) after confirmation |
| svgelements | MIT | SVG import with transforms, viewBox and physical units |
| ezdxf | MIT | DXF import (entities, blocks, `$INSUNITS`) and DXF export |
| opencv-python-headless | Apache-2.0 | photographed sketches: decoding with EXIF orientation, sheet detection, perspective, adaptive threshold, distance transforms; imported only when a photo is processed |
| react, react-router, @tanstack/react-query | MIT | interface (scaffold) |
| three, @react-three/fiber, @react-three/drei | MIT | 3D scene of the model |
| zustand | MIT | screen state |
| clipper2-ts | BSL-1.0 | automatic repair of live sections: union of self-crossing or overlapping loops in integer arithmetic; chosen over `clipper2-js`, unmaintained since January 2024 |
| tailwindcss, vite, typescript, vitest | MIT | build and tests (development only) |
| uplot | MIT | live charts: coefficient history, Cp along the contour, probes |
| playwright-core | Apache-2.0 | browser tests with the system Chrome (development only) |
| @webgpu/types | BSD-3-Clause | TypeScript declarations of WebGPU for the 3D tunnel; no code in the bundle (development only) |
| numba | BSD-2 | the CPU reference solver the shader is checked against (tests only) |
| pillow | MIT-CMU | draws the icons; writes EXIF-rotated photos in the tests (development only) |

Photos in HEIC (iPhone) are not supported: they get a message asking for a JPEG. Reading
them would need `pillow-heif` and libheif (LGPL), left out of v1.

drei components that download assets at runtime (environment maps, GPU detection) are never
used: the page's Content-Security-Policy would block them anyway.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
