#!/usr/bin/env bash
# galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Removes what install.sh installed -- the command, the menu entry, the icons --
# and nothing of the user's. The data stays unless the user asks, separately
# and explicitly, for it to go: the question is asked on a terminal and only
# "sì" (or "si") answers it. Without a terminal the data stays.
#
# Every path removed is written ${VAR:?}: an empty variable stops the script
# instead of turning a removal into one of the filesystem root.
set -euo pipefail

APP_ID="galleriadelvento"
APP_NAME="galleriaDelVento"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
LAUNCHER="$HOME/.local/bin/$APP_ID"
APPS_DIR="$DATA_HOME/applications"
DESKTOP="$APPS_DIR/$APP_ID.desktop"
ICONS_DIR="$DATA_HOME/icons/hicolor"
MARK="# $APP_NAME launcher, written by install.sh"

say() { printf '%s\n' "$*"; }
removed=()

if [ -e "$LAUNCHER" ]; then
  if grep -qF "$MARK" "$LAUNCHER" 2>/dev/null; then
    rm -f -- "${LAUNCHER:?}"
    removed+=("$LAUNCHER")
  else
    say "lascio $LAUNCHER: non l'ha scritto install.sh"
  fi
fi
if [ -e "$DESKTOP" ]; then
  rm -f -- "${DESKTOP:?}"
  removed+=("$DESKTOP")
fi
for icon in "48x48/apps/$APP_ID.png" "128x128/apps/$APP_ID.png" \
  "256x256/apps/$APP_ID.png" "scalable/apps/$APP_ID.svg"; do
  if [ -e "$ICONS_DIR/$icon" ]; then
    rm -f -- "${ICONS_DIR:?}/${icon:?}"
    removed+=("$ICONS_DIR/$icon")
  fi
done
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS_DIR" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$ICONS_DIR" 2>/dev/null || true

if [ ${#removed[@]} -eq 0 ]; then
  say "Nulla da rimuovere: $APP_NAME non risulta installato."
else
  say "Rimossi:"
  for path in "${removed[@]}"; do say "  $path"; done
fi

# --- the user's data: only on an explicit yes ----------------------------------
DATA="$DATA_HOME/$APP_ID"
STATE="$STATE_HOME/$APP_ID"
if [ -d "$DATA" ] || [ -d "$STATE" ]; then
  say ""
  say "I tuoi dati sono ancora al loro posto:"
  [ -d "$DATA" ] && say "  $DATA"
  [ -d "$STATE" ] && say "  $STATE  (log)"
  if [ -t 0 ]; then
    printf 'Vuoi cancellare anche questi dati? Non si possono recuperare. Scrivi «sì» per confermare: '
    read -r answer || answer=""
    case "$answer" in
      sì | si | SÌ | SI | Sì | Si)
        rm -rf -- "${DATA:?}" "${STATE:?}"
        say "Dati cancellati."
        ;;
      *) say "Dati conservati." ;;
    esac
  else
    say "Nessun terminale per chiedere conferma: i dati restano. Per cancellarli a mano:"
    say "  rm -rf \"$DATA\" \"$STATE\""
  fi
fi
