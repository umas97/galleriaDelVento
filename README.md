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
```

## Layout

```
backend/gdv/
  __main__.py        command line
  runtime.py         start-up and shutdown: lock, server, window, signals
  config.py          settings and XDG folders
  server.py          local HTTP server (127.0.0.1 only) and base API
  security.py        who may talk to the server (Host/Origin)
  window.py          the application window
  single_instance.py one program at a time
  static/            the interface served by the server (built from frontend/)
frontend/            React + TypeScript + Vite sources
packaging/           icons and their generator
tests/               tests (pytest)
docs/SPEC.md         the specification
```

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
