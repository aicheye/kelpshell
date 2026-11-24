#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Run Kelpshell in a private headless GNOME Shell, without touching the
# running session. It has its own D-Bus session, settings, and Wayland socket.
#
#   dev/headless.sh start [WxH] [WxH]   start the shell (second size: a second monitor)
#   dev/headless.sh stop                stop it
#   dev/headless.sh run CMD...          run a program inside it, e.g. run gnome-calculator
#   dev/headless.sh js 'EXPR'           evaluate JavaScript in the shell; `kelp` is the extension
#   dev/headless.sh shot FILE.png       save a screenshot
#   dev/headless.sh key KEY...          press a key combo, e.g. key Super_L Left
#   dev/headless.sh log                 print extension errors from the shell log
#
# Example:
#   dev/headless.sh start && dev/headless.sh run gnome-text-editor
#   dev/headless.sh key Super_L space && dev/headless.sh shot /tmp/launcher.png
set -euo pipefail

UUID="kelpshell@aicheye"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Socket paths are limited to 108 bytes, so this lives in the runtime dir.
ROOT="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/kelpshell-test"

session_env() {
    export XDG_RUNTIME_DIR="$ROOT/run"
    export XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data"
    export XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state"
    export XDG_DATA_DIRS=/usr/local/share:/usr/share XDG_CURRENT_DESKTOP=GNOME
    unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
}

client_env() {
    [[ -f "$ROOT/bus" ]] || { echo "not running: dev/headless.sh start" >&2; exit 1; }
    session_env
    export DBUS_SESSION_BUS_ADDRESS="$(cat "$ROOT/bus")"
    export WAYLAND_DISPLAY=kelp-test GDK_BACKEND=wayland
}

shell_eval() {
    gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Eval "$1"
}

stop() {
    if [[ -f "$ROOT/pid" ]]; then
        local pid
        pid="$(cat "$ROOT/pid")"
        kill -TERM -- "-$pid" 2>/dev/null || true
        sleep 0.5
        kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    command rm -rf "$ROOT"
}

case "${1:-}" in
start)
    stop
    size="${2:-1920x1080}"
    extra=""
    [[ -n "${3:-}" ]] && extra="--virtual-monitor $3"
    mkdir -p "$ROOT"/{run,config,data/gnome-shell/extensions,cache,state}
    chmod 700 "$ROOT/run"
    ln -sfn "$REPO/$UUID" "$ROOT/data/gnome-shell/extensions/$UUID"
    session_env
    export KELPSHELL_DEBUG=1 KELP_ROOT="$ROOT" KELP_UUID="$UUID" KELP_SIZE="$size" KELP_EXTRA="$extra"
    # shellcheck disable=SC2016
    setsid dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" > "$KELP_ROOT/bus"
        gsettings set org.gnome.shell welcome-dialog-last-shown-version 999
        gsettings set org.gnome.shell disable-user-extensions false
        gsettings set org.gnome.shell enabled-extensions "['"'"'$KELP_UUID'"'"']"
        gsettings set org.gnome.desktop.interface color-scheme prefer-dark
        exec gnome-shell --headless --virtual-monitor "$KELP_SIZE" $KELP_EXTRA \
            --wayland-display kelp-test --unsafe-mode
    ' > "$ROOT/shell.log" 2>&1 &
    echo $! > "$ROOT/pid"
    for _ in $(seq 1 60); do
        [[ -S "$ROOT/run/kelp-test" ]] && break
        sleep 0.25
    done
    sleep 2
    if [[ ! -S "$ROOT/run/kelp-test" ]]; then
        echo "shell did not start, see $ROOT/shell.log" >&2
        exit 1
    fi
    client_env
    shell_eval 'Main.overview.hide(); "extension state " + Main.extensionManager.lookup("'"$UUID"'")?.state + " (1 is active)"'
    ;;
stop)
    stop
    ;;
run)
    client_env
    shift
    setsid "$@" > /dev/null 2>&1 &
    ;;
js)
    client_env
    shell_eval "$2"
    ;;
shot)
    client_env
    gdbus call --session -d org.gnome.Shell.Screenshot -o /org/gnome/Shell/Screenshot \
        -m org.gnome.Shell.Screenshot.Screenshot false false "$(realpath -m "$2")" > /dev/null
    echo "$2"
    ;;
key)
    client_env
    shift
    press="" release=""
    for k in "$@"; do
        press+="v.notify_keyval(t(), C.KEY_$k, C.KeyState.PRESSED);"
        release="v.notify_keyval(t(), C.KEY_$k, C.KeyState.RELEASED);$release"
    done
    shell_eval "const C = imports.gi.Clutter; globalThis._vk ??= global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const v = globalThis._vk; const t = () => imports.gi.GLib.get_monotonic_time(); $press $release 1" > /dev/null
    ;;
log)
    [[ -f "$ROOT/shell.log" ]] || { echo "no log" >&2; exit 1; }
    grep -n "JS ERROR\|kelpshell\|Gjs-CRITICAL\|St-WARNING" -A8 "$ROOT/shell.log" | grep -v "dbus-daemon" || echo "no extension errors"
    ;;
*)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
