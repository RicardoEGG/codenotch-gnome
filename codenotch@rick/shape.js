import {L} from './layout.js';

// The notch body in canonical form — the right edge: a pill welded to the
// screen edge with inverse rounded corners (flares) at each end, so it reads
// as part of the bezel rather than a floating panel. Port of
// SideNotchShape.swift.
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

// The path is only ever written once, for the right edge, and then
// transformed onto whichever edge it is actually on. Draws the shape flush
// with `edge` of a `w` x `h` area, centred along it.
export function edgeNotchPath(cr, edge, w, h, depth, length) {
    cr.save();
    switch (edge) {
    case 'right':
        notchPath(cr, w - depth, (h - length) / 2, depth, length);
        break;
    case 'left':
        // Mirrored: the flares point the other way.
        cr.translate(depth, 0);
        cr.scale(-1, 1);
        notchPath(cr, 0, (h - length) / 2, depth, length);
        break;
    case 'top':
        // Quarter turn, bezel to the top: (across, along) -> (along, depth - across).
        cr.translate(0, depth);
        cr.rotate(-Math.PI / 2);
        notchPath(cr, 0, (w - length) / 2, depth, length);
        break;
    case 'bottom':
        // Quarter turn the other way, bezel to the bottom.
        cr.translate(0, h - depth);
        cr.scale(-1, 1);
        cr.rotate(Math.PI / 2);
        notchPath(cr, 0, (w - length) / 2, depth, length);
        break;
    }
    cr.restore();
}

// The hover card: a rounded rectangle with a solid triangular tail on `side`
// ('left' | 'right' | 'top' | 'bottom'), pointing at the hovered cell. `tip`
// is where along that side the tail points, relative to the rectangle.
export function cardPath(cr, x, y, w, h, corner, side, tailLength, tailHeight, tip) {
    const r = Math.min(corner, w / 2, h / 2);
    const half = tailHeight / 2;
    const base = along => {
        const lo = r + half;
        const hi = along - r - half;
        return lo <= hi ? Math.max(lo, Math.min(hi, tip)) : along / 2;
    };

    cr.newPath();
    cr.moveTo(x + r, y);
    if (side === 'top') {
        const b = base(w);
        cr.lineTo(x + b - half, y);
        cr.lineTo(x + b, y - tailLength);
        cr.lineTo(x + b + half, y);
    }
    cr.lineTo(x + w - r, y);
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    if (side === 'right') {
        const b = base(h);
        cr.lineTo(x + w, y + b - half);
        cr.lineTo(x + w + tailLength, y + b);
        cr.lineTo(x + w, y + b + half);
    }
    cr.lineTo(x + w, y + h - r);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    if (side === 'bottom') {
        const b = base(w);
        cr.lineTo(x + b + half, y + h);
        cr.lineTo(x + b, y + h + tailLength);
        cr.lineTo(x + b - half, y + h);
    }
    cr.lineTo(x + r, y + h);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    if (side === 'left') {
        const b = base(h);
        cr.lineTo(x, y + b + half);
        cr.lineTo(x - tailLength, y + b);
        cr.lineTo(x, y + b - half);
    }
    cr.lineTo(x, y + r);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}
