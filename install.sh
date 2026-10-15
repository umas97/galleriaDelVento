#!/usr/bin/env bash
# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs galleriaDelVento for the current user, as a desktop application: the
# command in ~/.local/bin, the icons in the hicolor theme, the menu entry, whose
# StartupWMClass is the identity the window ends up with -- which is what puts
# the right icon and name in the dock.
#
# Idempotent: running it again updates what it installed and nothing else.
# Never uses sudo and never installs system packages: when something is missing
# it prints the exact command and stops.
#
# For tests and development only:
#   GDV_INSTALL_SKIP_SYNC=1      do not touch the environment (.venv must exist)
#   GDV_INSTALL_SKIP_FRONTEND=1  do not build the interface (the build must exist)
set -euo pipefail

APP_ID="galleriadelvento"
APP_NAME="galleriaDelVento"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/$APP_ID"
APPS_DIR="$DATA_HOME/applications"
DESKTOP="$APPS_DIR/$APP_ID.desktop"
ICONS_DIR="$DATA_HOME/icons/hicolor"
MARK="# $APP_NAME launcher, written by install.sh"
STATIC="$REPO/backend/gdv/static"

say() { printf '%s\n' "$*"; }
stop() {
  printf 'errore: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

# --- 1. what must already be on the machine -----------------------------------
command -v uv >/dev/null 2>&1 || stop "manca uv, che installa le dipendenze Python." \
  "Installalo con:" "curl -LsSf https://astral.sh/uv/install.sh | sh" \
  "poi riapri il terminale e rilancia ./install.sh"
if ! uv python find 3.12 >/dev/null 2>&1; then
  stop "manca Python 3.12." "Installalo con:" "uv python install 3.12"
fi

# --- 2. the Python environment ------------------------------------------------
cd "$REPO"
if [ "${GDV_INSTALL_SKIP_SYNC:-0}" != "1" ]; then
  say "Installo le dipendenze Python (uv sync)…"
  uv sync --python 3.12
fi
PYTHON="$REPO/.venv/bin/python"
[ -x "$REPO/.venv/bin/$APP_ID" ] || stop "l'ambiente $REPO/.venv non contiene $APP_ID." \
  "Rilancia ./install.sh senza GDV_INSTALL_SKIP_SYNC."
[ -f "$REPO/packaging/icons/$APP_ID.svg" ] || "$PYTHON" "$REPO/packaging/make_icons.py"

# --- 3. the interface ---------------------------------------------------------
if [ "${GDV_INSTALL_SKIP_FRONTEND:-0}" != "1" ] && command -v npm >/dev/null 2>&1; then
  say "Costruisco l'interfaccia (npm)…"
  (cd frontend && npm ci --no-audit --no-fund && npm run build)
elif [ -f "$STATIC/index.html" ]; then
  say "Uso l'interfaccia già costruita in backend/gdv/static/ (Node non serve)."
else
  stop "manca l'interfaccia costruita e Node non è installato." \
    "Usa un pacchetto di release (contiene backend/gdv/static/) oppure installa Node:" \
    "sudo apt install nodejs npm"
fi
[ -f "$STATIC/index.html" ] || stop "l'interfaccia in $STATIC è incompleta (manca index.html)."

# --- 4. command, icons, menu entry -------------------------------------------
mkdir -p "$BIN_DIR" "$APPS_DIR"
if [ -e "$LAUNCHER" ] && ! grep -qF "$MARK" "$LAUNCHER" 2>/dev/null; then
  stop "$LAUNCHER esiste già e non l'ha scritto install.sh." "Spostalo o rimuovilo, poi rilancia."
fi
cat >"$LAUNCHER.tmp" <<LAUNCH
#!/bin/sh
$MARK
exec "$REPO/.venv/bin/$APP_ID" "\$@"
LAUNCH
chmod 755 "$LAUNCHER.tmp"
mv -f "$LAUNCHER.tmp" "$LAUNCHER"

for size in 48 128 256; do
  install -D -m 644 "$REPO/packaging/icons/$APP_ID-$size.png" "$ICONS_DIR/${size}x${size}/apps/$APP_ID.png"
done
install -D -m 644 "$REPO/packaging/icons/$APP_ID.svg" "$ICONS_DIR/scalable/apps/$APP_ID.svg"

# The window's identity is not ours to choose: under Wayland Chromium derives it
# from its own name and the window's URL, so it is asked of the code that opens
# the window (backend/gdv/window.py, window_class).
WM_CLASS="$("$PYTHON" -c "from gdv.window import window_class; print(window_class())" 2>/dev/null || true)"
[ -n "$WM_CLASS" ] || WM_CLASS="chrome-127.0.0.1__$APP_ID-Default"

# Written and validated aside, then moved in place: the menu never sees half an entry.
STAGING="$(mktemp -d)"
trap 'rm -rf -- "${STAGING:?}"' EXIT
cat >"$STAGING/$APP_ID.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Version=1.5
Name=$APP_NAME
GenericName=Galleria del vento
Comment=Galleria del vento 2D in tempo reale per sezioni, schizzi e profili
Exec=$LAUNCHER
Icon=$APP_ID
Terminal=false
Categories=Education;Science;Physics;
Keywords=galleria;vento;aerodinamica;CFD;LBM;wind tunnel;
StartupNotify=true
StartupWMClass=$WM_CLASS
ENTRY
sed -i '/^Keywords=$/d' "$STAGING/$APP_ID.desktop"
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$STAGING/$APP_ID.desktop" || stop "la voce di menu generata non è valida (vedi sopra)."
fi
install -m 644 "$STAGING/$APP_ID.desktop" "$DESKTOP.tmp"
mv -f "$DESKTOP.tmp" "$DESKTOP"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS_DIR" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$ICONS_DIR" 2>/dev/null || true

# --- 5. what was installed, and where -----------------------------------------
say ""
say "$APP_NAME installato."
say "  comando:       $LAUNCHER  →  $REPO/.venv/bin/$APP_ID"
say "  voce di menu:  $DESKTOP"
say "  finestra/dock: $WM_CLASS"
say "  icone:         $ICONS_DIR/{48x48,128x128,256x256,scalable}/apps/"
say "  i tuoi dati:   $DATA_HOME/$APP_ID/ (creata al primo avvio)"
BROWSER="$("$PYTHON" -c "from gdv.window import find_browser; b = find_browser(); print(' '.join(b) if b else '')" 2>/dev/null || true)"
if [ -n "$BROWSER" ]; then
  say "  finestra:      $BROWSER in modalità applicazione"
else
  say "  finestra:      nessun browser Chromium trovato: si aprirà in una scheda del browser"
  say "                 predefinito. Per la finestra dedicata: sudo snap install chromium"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  nota:          $BIN_DIR non è nel PATH: dal terminale usa $LAUNCHER" ;;
esac
say ""
say "Aprilo dal menu delle applicazioni («$APP_NAME») o con: $APP_ID"
say "Per disinstallarlo: ./uninstall.sh (i tuoi dati restano, salvo conferma esplicita)."
