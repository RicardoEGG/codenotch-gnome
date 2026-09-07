import {L} from './layout.js';

// The notch body for the right edge: a pill welded to the screen edge with
// inverse rounded corners (flares) at each end, so it reads as part of the
// bezel rather than a floating panel. Port of SideNotchShape.swift.
//
// `x`/`y` is the top-left of the shape's bounding box; the bezel is at
// `x + depth`. The clamping order matters: the corner is claimed first, out of
// half the depth, and the flare takes what is left — otherwise the resting
// pill comes out with square corners.
export function notchPath(cr, x, y, depth, length, flare = L.curlRadius,
    cornerRadius = L.cornerRadius) {
    const wanted = Math.max(0, Math.min(cornerRadius, depth / 2));
    const curl = Math.max(0, Math.min(flare, length / 2, depth - wanted));
    const corner = Math.max(0, Math.min(wanted, (length - 2 * curl) / 2));
    const right = x + depth;
    const bottom = y + length;

    cr.newPath();
    cr.moveTo(right, y);
    if (curl > 0)
        cr.arc(right - curl, y, curl, 0, Math.PI / 2);
    cr.lineTo(x + corner, y + curl);
    cr.arcNegative(x + corner, y + curl + corner, corner, -Math.PI / 2, Math.PI);
    cr.lineTo(x, bottom - curl - corner);
    cr.arcNegative(x + corner, bottom - curl - corner, corner, Math.PI, Math.PI / 2);
    cr.lineTo(right - curl, bottom - curl);
    if (curl > 0)
        cr.arc(right - curl, bottom, curl, -Math.PI / 2, 0);
    cr.closePath();
}

export function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// The hover card: a rounded rectangle with a solid triangular tail on its
// right side, pointing at the hovered cell. `tipY` is relative to the card top.
export function cardPath(cr, x, y, w, h, corner, tailLength, tailHeight, tipY) {
    const r = Math.min(corner, w / 2, h / 2);
    const half = tailHeight / 2;
    const base = Math.max(r, Math.min(h - r, tipY));
    const top = base - half;
    const bot = base + half;

    cr.newPath();
    cr.moveTo(x + r, y);
    cr.lineTo(x + w - r, y);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.lineTo(x + w, y + top);
    cr.lineTo(x + w + tailLength, y + base);
    cr.lineTo(x + w, y + bot);
    cr.lineTo(x + w, y + h - r);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.lineTo(x + r, y + h);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.lineTo(x, y + r);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}
