#!/bin/bash
# Build the native modules for the installed GNOME Shell:
#
#   native/decorations.c   server-side decorations for chosen Wayland clients
#   native/drag.c          dragging files from the shell into a Wayland client
#   native/scroll.c        touchpad scroll events, given to the extension first
#
#   dev/build-native.sh
#
# Needs gcc and the GLib headers (Fedora: gcc glib2-devel). The modules go to
# kelpshell@aicheye/native/<shell version>/ and are loaded by the next shell
# that starts. They use Mutter functions that are not in its public headers,
# so they are only loaded by the shell version they were built for: run this
# again after an upgrade of GNOME.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(gnome-shell --version | grep -o '[0-9]\+' | head -1)"
OUT="$REPO/kelpshell@aicheye/native/$VERSION"

mkdir -p "$OUT"
# -z now: every function is looked up when a module is loaded. A shell
# without one of them then refuses the module, and does not stop at the first
# call of that function.
for name in decorations drag scroll; do
    # shellcheck disable=SC2046
    gcc -shared -fPIC -O2 -Wall -Wl,-z,now \
        $(pkg-config --cflags gio-2.0) \
        -o "$OUT/libkelp-$name.so" "$REPO/native/$name.c"
    echo "$OUT/libkelp-$name.so"
done
