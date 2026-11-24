// SPDX-License-Identifier: GPL-3.0-or-later

// How far a touchpad swipe moves the picture.
//
// A swipe that scrolls the strip or slides the workspaces moves them as far
// as the same movement of one finger moves the pointer, in px. The windows
// then stay under the fingers the way the pointer does, on every monitor
// and at every pointer speed set in the system settings.
//
// libinput reports two distances for a swipe. The one without acceleration
// is in units of the touchpad, and the shell's own gestures use it with a
// fixed length per gesture: 300 units slide the workspaces by the height of
// the monitor, which is 5.1 px per unit on a 1440 px high monitor. The other
// has the acceleration and the speed of the pointer applied, and Mutter
// moves the pointer by exactly that (meta_seat_impl_filter_relative_motion
// in Mutter 51). That one is used here.

import St from 'gi://St';

/**
 * [dx, dy] in stage px: how far the pointer on a monitor moves for the
 * movement of the fingers in a swipe event, times gestures.sensitivity.
 *
 * Mutter moves the pointer by the accelerated distance in the pixels of the
 * stage where it scales the monitors itself (St's scale factor is 1 then),
 * and by that distance times the scale of the monitor where the stage has
 * the pixels of the monitors.
 */
export function pointerDelta(event, monitor, config) {
    const [dx, dy] = event.get_gesture_motion_delta();
    const physical = St.ThemeContext.get_for_stage(global.stage).scale_factor > 1;
    const scale = physical && monitor >= 0 ? global.display.get_monitor_scale(monitor) : 1;
    const set = Number(config.values.gestures.sensitivity);
    const k = scale * Math.min(Math.max(Number.isFinite(set) ? set : 1, 0.1), 10);
    return [dx * k, dy * k];
}
