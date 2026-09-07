// Every number here is measured off codenotch's design frame
// (docs/design/frame-124-hover-tooltip.png, 2000x2000 px). The provider ring
// is 44 logical px and measures 117 px in the frame, which pins the scale;
// everything else keeps the frame's proportions. Mirrors NotchLayout.swift.
const SCALE = 44 / 117;
export const px = p => p * SCALE;

// Cap-height fraction of an em. SF Pro is 0.714; Adwaita Sans is close enough
// that text measured by cap height in the frame lands at the same size.
const CAP_RATIO = 0.714;
export const fontSize = capPixels => px(capPixels) / CAP_RATIO;

export const L = {
    // The notch body
    bodyDepth: px(186),
    curlRadius: px(103),
    cornerRadius: px(78.8),
    padTop: px(69.5),        // body top -> first ring
    padBottom: px(50.1),     // last label -> body bottom
    cellSpacing: px(83.5),   // label bottom -> next ring top

    // The resting pill
    pillWidth: px(26),
    pillHeight: px(210),
    pillHotZone: px(90),

    // A provider cell
    ringDiameter: px(117),
    trackStroke: px(15.5),
    progressStroke: px(8),
    glyphSize: px(46),
    ringLabelGap: px(26.9),
    percentFont: fontSize(27),

    // The activity indicator, between the glyph and the track
    activityDiameter: px(72),
    activityStroke: px(5.5),

    // The hover card
    cardWidth: px(600),
    cardCorner: px(49.5),
    cardPadding: px(32),
    tailLength: px(75),
    tailHeight: px(87),
    tailGap: px(28),         // tail tip -> notch body edge
    barHeight: px(10.5),
    headerGap: px(17),       // glyph -> title
    headerToBlock: px(21),
    labelToBar: px(16.8),
    barToUsed: px(17.8),
    blockSpacing: px(20),
    sessionRowGap: px(10),
    statusDot: px(17),
    statusDotStroke: px(3.4),
    statusDotGap: px(11),
    hairline: 1,
    titleFont: fontSize(26),
    bodyFont: fontSize(18),

    // Room the envelope keeps around the shape so an unfold can overshoot.
    envelopeMargin: 16,
    envelopeSlack: 48,
    sessionCap: 4,
};

L.percentLineHeight = Math.ceil(L.percentFont * 1.25);
L.ringMargin = (L.bodyDepth - L.ringDiameter) / 2;
L.cellExtent = L.ringDiameter + L.ringLabelGap + L.percentLineHeight;
L.cellPitch = L.cellExtent + L.cellSpacing;
L.cardTextWidth = L.cardWidth - 2 * L.cardPadding;

export function bodyLength(cellCount) {
    if (cellCount <= 0)
        return L.padTop + L.padBottom;
    return L.padTop + cellCount * L.cellExtent + (cellCount - 1) * L.cellSpacing + L.padBottom;
}

export function shapeLength(cellCount) {
    return bodyLength(cellCount) + 2 * L.curlRadius;
}

// Distance from the top of the shape (flare included) to the ring's centre.
export function ringCenter(index) {
    return L.curlRadius + L.padTop + L.ringDiameter / 2 + index * L.cellPitch;
}

// Sampled from the design frame, not invented (Palette.swift).
export const Palette = {
    notch: '#000000',
    card: '#000000',
    ringTrack: '#303030',
    barTrack: '#2D2D2D',
    ample: '#00FF88',
    watch: '#F2FF00',
    critical: '#FF3F00',
    textPrimary: '#FFFFFF',
    textSecondary: '#808080',
};

export function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function setColor(cr, hex, alpha = 1) {
    const [r, g, b] = rgb(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

// UsageBand.swift: what a fraction used means for you.
export function band(fraction) {
    if (fraction == null)
        return null;
    if (fraction >= 1)
        return 'exhausted';
    if (fraction >= 0.7)
        return 'critical';
    if (fraction >= 0.5)
        return 'watch';
    return 'ample';
}

export function bandColor(b) {
    switch (b) {
    case 'ample': return Palette.ample;
    case 'watch': return Palette.watch;
    default: return Palette.critical;
    }
}
