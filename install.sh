#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Install or remove Kelpshell for the current user.
#
#   ./install.sh             build, link the extension and create a config file
#   ./install.sh --uninstall remove the link (the config file is kept)
#
# The extension is linked, not copied, so edits in this repository apply the
# next time the shell loads it.
set -euo pipefail

UUID="kelpshell@aicheye"
REPO="$(cd "$(dirname "$0")" && pwd)"
TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/kelpshell"

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    if [[ -L "$TARGET" ]]; then
        rm "$TARGET"
        echo "Removed $TARGET"
    else
        echo "No link at $TARGET"
    fi
    echo "Config kept at $CONFIG_DIR"
    exit 0
fi

if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
    echo "$TARGET exists and is not a link. Move it away first." >&2
    exit 1
fi

# The light style is made from the dark one.
"$REPO/dev/light-css.py"

mkdir -p "$(dirname "$TARGET")" "$CONFIG_DIR"
ln -sfn "$REPO/$UUID" "$TARGET"
echo "Linked $TARGET -> $REPO/$UUID"

if [[ ! -e "$CONFIG_DIR/config.jsonc" ]]; then
    cp "$REPO/config.example.jsonc" "$CONFIG_DIR/config.jsonc"
    echo "Created $CONFIG_DIR/config.jsonc"
fi

# The native modules are optional, see "Native modules" in the README.
if command -v gcc > /dev/null && pkg-config --exists gio-2.0 2> /dev/null; then
    "$REPO/dev/build-native.sh" | sed 's/^/Built /'
else
    echo "Native modules not built: gcc or the GLib headers are missing."
fi

cat <<EOF

Next:
  1. Log out and back in (a Wayland session only finds new extensions at login).
  2. Disable other tiling extensions, for example:
       gnome-extensions disable forge@jmmaranan.com
  3. gnome-extensions enable $UUID
EOF
