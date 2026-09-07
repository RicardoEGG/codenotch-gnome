import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {L, Palette, Appearance, setColor, band, bandColor,
    bodyDepth, shapeLength, ringCenter, cellPitch} from './layout.js';
import {edgeNotchPath, cardPath} from './shape.js';
import {drawGlyph} from './glyphs.js';
import {resetText, elapsedText, percentText} from './copy.js';
import {ClaudeSessionMonitor, summarize} from './sessions.js';

// The motion vocabulary (NotchMotion.swift), as Clutter modes. Springs are
// approximated: EASE_OUT_BACK gives the unfold its single soft overshoot.
const Motion = {
    unfold: {duration: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK},
    fold: {duration: 300, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD},
    contents: {duration: 360, mode: Clutter.AnimationMode.EASE_OUT_QUAD},
    glide: {duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUART},
    crossfade: {duration: 160, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD},
    reading: {duration: 900, mode: Clutter.AnimationMode.EASE_OUT_CUBIC},
    stagger: index => Math.min(index * 45, 180),
};

const STALE_AFTER = 20 * 1000;    // ms: unfolding re-reads anything older
const POLL_INTERVAL = 60;         // ms: pointer tracking while unfolded
const LEAVE_GRACE = 250;          // ms: the pointer has to cross the gap to the card
const CARD_TICK = 30;             // seconds between relative-time refreshes
const EDGE_MARGIN = 8;            // px the card keeps from the work area's ends

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Which side of the card the tail is on, for a notch on `edge`.
const TAIL_SIDE = {right: 'right', left: 'left', top: 'top', bottom: 'bottom'};

function doubleSpec(name, min, max, initial) {
    return GObject.ParamSpec.double(name, name, name,
        GObject.ParamFlags.READWRITE, min, max, initial);
}

// The notch body: pill at rest, unfolding to the full shape as `progress`
// goes 0 -> 1. Drawn flush with the actor's edge, centred along it.
const ShapeArea = GObject.registerClass({
    Properties: {'progress': doubleSpec('progress', -1, 2, 0)},
}, class ShapeArea extends St.DrawingArea {
    _init(edge) {
        super._init({reactive: false});
        this._edge = edge;
        this._progress = 0;
        this.fullLength = L.pillHeight;
        this.fullDepth = L.bodyDepth;
    }

    get progress() {
        return this._progress;
    }

    set progress(value) {
        if (value === this._progress)
            return;
        this._progress = value;
        this.notify('progress');
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const p = this._progress;
        const depth = lerp(L.pillWidth, this.fullDepth, p);
        const length = lerp(L.pillHeight, this.fullLength, p);
        edgeNotchPath(cr, this._edge, w, h, depth, length);
        setColor(cr, Appearance.color, Appearance.opacity);
        cr.fill();
        cr.$dispose();
    }
});

// A grey track with a coloured arc from 12 o'clock, clockwise, by the
// fraction used, and the provider's mark in the middle (ProviderRing.swift).
const RingArea = GObject.registerClass({
    Properties: {'sweep': doubleSpec('sweep', 0, 1, 0)},
}, class RingArea extends St.DrawingArea {
    _init(glyph) {
        super._init({width: L.ringDiameter, height: L.ringDiameter, reactive: false});
        this._glyph = glyph;
        this._sweep = 0;
        this._band = null;
        this._hasReading = false;
    }

    get sweep() {
        return this._sweep;
    }

    set sweep(value) {
        if (value === this._sweep)
            return;
        this._sweep = value;
        this.notify('sweep');
        this.queue_repaint();
    }

    setReading(fraction) {
        this._hasReading = fraction !== null;
        this._band = band(fraction);
        this.queue_repaint();
        this.remove_transition('sweep');
        this.ease_property('sweep', clamp(fraction ?? 0, 0, 1), Motion.reading);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const radius = L.ringDiameter / 2 - L.trackStroke / 2;

        setColor(cr, Palette.ringTrack);
        cr.setLineWidth(L.trackStroke);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._hasReading && this._sweep > 0) {
            setColor(cr, bandColor(this._band));
            cr.setLineWidth(L.progressStroke);
            cr.setLineCap(1); // round
            const start = -Math.PI / 2;
            cr.arc(cx, cy, radius, start, start + 2 * Math.PI * this._sweep);
            cr.stroke();
        }

        // A spent limit dims its glyph so the ring reads as "waiting".
        drawGlyph(cr, this._glyph, cx, cy, L.glyphSize, this._band === 'exhausted' ? 0.35 : 1);
        cr.$dispose();
    }
});

// The inner indicator: a short arc that spins while work is happening, and a
// full pulsing ring when something is blocked waiting on you.
const ActivityArea = GObject.registerClass(
class ActivityArea extends St.DrawingArea {
    _init() {
        super._init({width: L.ringDiameter, height: L.ringDiameter, reactive: false});
        this._state = null;
        this._phase = 0;
        this._timeline = null;
        this.connect('destroy', () => this._stop());
    }

    setState(state) {
        if (state === this._state)
            return;
        this._state = state;
        this._stop();
        if (state === 'working')
            this._run(1100, false, Clutter.AnimationMode.LINEAR);
        else if (state === 'waiting')
            this._run(900, true, Clutter.AnimationMode.EASE_IN_OUT_QUAD);
        this.queue_repaint();
    }

    _run(duration, autoReverse, mode) {
        const timeline = Clutter.Timeline.new_for_actor(this, duration);
        timeline.set_repeat_count(-1);
        timeline.set_auto_reverse(autoReverse);
        timeline.set_progress_mode(mode);
        timeline.connect('new-frame', () => {
            this._phase = timeline.get_progress();
            this.queue_repaint();
        });
        timeline.start();
        this._timeline = timeline;
    }

    _stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }
        this._phase = 0;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        if (this._state) {
            const [w, h] = this.get_surface_size();
            const radius = L.activityDiameter / 2;
            cr.setLineWidth(L.activityStroke);
            if (this._state === 'working') {
                setColor(cr, Palette.textPrimary);
                cr.setLineCap(1);
                const start = -Math.PI / 2 + this._phase * 2 * Math.PI;
                cr.arc(w / 2, h / 2, radius, start, start + Math.PI / 2);
            } else {
                setColor(cr, Palette.watch, 1 - 0.7 * this._phase);
                cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
            }
            cr.stroke();
        }
        cr.$dispose();
    }
});

// A ring and the percent burned underneath it. Upright on every edge; along a
// vertical edge the cell is as wide as the body and the ring sits in the
// middle, along a horizontal one it is only as wide as the ring and the label
// overhangs into the spacing that is already there for it.
const Cell = GObject.registerClass(
class Cell extends St.Widget {
    _init(provider, vertical) {
        const width = vertical ? L.bodyDepth : L.ringDiameter;
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            width,
            height: L.cellExtent,
            opacity: 0,
            reactive: false,
        });
        this.provider = provider;
        const ringX = vertical ? L.ringMargin : 0;
        this._ring = new RingArea(provider.glyph);
        this._ring.set_position(ringX, 0);
        this._activity = new ActivityArea();
        this._activity.set_position(ringX, 0);
        this.add_child(this._ring);
        this.add_child(this._activity);

        this._label = null;
        if (L.showLabels) {
            const labelWidth = vertical ? L.bodyDepth : L.ringDiameter + L.cellSpacing;
            this._label = new St.Label({
                text: '—',
                reactive: false,
                width: labelWidth,
                height: L.percentLineHeight,
                style: `font-size: ${L.percentFont.toFixed(1)}px; font-weight: 600; ` +
                       `color: ${Palette.textPrimary}; text-align: center;`,
            });
            this._label.set_position((width - labelWidth) / 2, L.ringDiameter + L.ringLabelGap);
            this.add_child(this._label);
        }
    }

    update(state, activity) {
        const headline = headlineOf(state.snapshot);
        const fraction = headline?.usedFraction ?? null;
        this._ring.setReading(fraction);
        // Dimming applies to the usage reading only: whether the tool is
        // working right now is known first-hand and stays at full strength.
        this._ring.opacity = state.status === 'ok' ? 255 : 115;
        if (this._label)
            this._label.text = fraction === null ? '—' : percentText(fraction);
        this._activity.setState(activity?.state === 'idle' ? null : activity?.state ?? null);
    }
});

function headlineOf(snapshot) {
    if (!snapshot || snapshot.windows.length === 0)
        return null;
    return snapshot.windows.find(w => w.id === snapshot.headlineID) ?? snapshot.windows[0];
}

// The hover card: provider glyph and title, one block per limit window, and
// the running sessions underneath (TooltipCard.swift).
const CardBackground = GObject.registerClass(
class CardBackground extends St.DrawingArea {
    _init(side) {
        super._init({reactive: false});
        this._side = side;
        this.tip = 0;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const vertical = this._side === 'left' || this._side === 'right';
        const rectX = this._side === 'left' ? L.tailLength : 0;
        const rectY = this._side === 'top' ? L.tailLength : 0;
        const rectW = vertical ? w - L.tailLength : w;
        const rectH = vertical ? h : h - L.tailLength;
        cardPath(cr, rectX, rectY, rectW, rectH, L.cardCorner, this._side,
            L.tailLength, L.tailHeight, this.tip);
        setColor(cr, Appearance.color, Appearance.opacity);
        cr.fill();
        cr.$dispose();
    }
});

function text(str, {size = L.bodyFont, weight = 400, color = Palette.textPrimary} = {}) {
    const label = new St.Label({
        text: str,
        reactive: false,
        style: `font-size: ${size.toFixed(1)}px; font-weight: ${weight}; color: ${color};`,
    });
    label.clutter_text.line_wrap = true;
    return label;
}

function splitRow(leading, trailing) {
    const row = new St.BoxLayout({width: L.cardTextWidth, reactive: false});
    trailing.x_expand = true;
    trailing.x_align = Clutter.ActorAlign.END;
    row.add_child(leading);
    row.add_child(trailing);
    return row;
}

function spacer(height) {
    return new St.Widget({width: L.cardTextWidth, height, reactive: false});
}

function hspacer(width) {
    return new St.Widget({width, height: 1, reactive: false});
}

function usageBar(fraction) {
    const radius = (L.barHeight / 2).toFixed(1);
    const track = new St.Widget({
        layout_manager: new Clutter.FixedLayout(),
        width: L.cardTextWidth,
        height: L.barHeight,
        reactive: false,
        style: `background-color: ${Palette.barTrack}; border-radius: ${radius}px;`,
    });
    const fill = new St.Widget({
        width: Math.max(L.barHeight, L.cardTextWidth * clamp(fraction, 0, 1)),
        height: L.barHeight,
        reactive: false,
        style: `background-color: ${bandColor(band(fraction))}; border-radius: ${radius}px;`,
    });
    track.add_child(fill);
    return track;
}

const StatusDot = GObject.registerClass(
class StatusDot extends St.DrawingArea {
    _init(color) {
        super._init({width: L.statusDot, height: L.statusDot, reactive: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._color = color;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        setColor(cr, this._color);
        cr.setLineWidth(L.statusDotStroke);
        cr.arc(w / 2, h / 2, w / 2 - L.statusDotStroke / 2, 0, 2 * Math.PI);
        cr.stroke();
        cr.$dispose();
    }
});

const Card = GObject.registerClass(
class Card extends St.Widget {
    _init(side) {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            visible: false,
            opacity: 0,
        });
        this._side = side;
        this._vertical = side === 'left' || side === 'right';
        this._bg = new CardBackground(side);
        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            width: L.cardTextWidth,
            reactive: false,
        });
        this._content.set_position(
            L.cardPadding + (side === 'left' ? L.tailLength : 0),
            L.cardPadding + (side === 'top' ? L.tailLength : 0));
        this.add_child(this._bg);
        this.add_child(this._content);
    }

    // Where along the tail's side the tail points, relative to the actor.
    setTip(along) {
        // The tail's inset is across the card, never along it, so the
        // actor-relative coordinate is the rectangle-relative one.
        this._bg.tip = along;
        this._bg.queue_repaint();
    }

    populate(provider, state, activity, now = new Date()) {
        this._content.destroy_all_children();
        const add = actor => this._content.add_child(actor);

        const header = new St.BoxLayout({width: L.cardTextWidth, reactive: false});
        const glyph = new St.DrawingArea({width: L.glyphSize, height: L.glyphSize, reactive: false,
            y_align: Clutter.ActorAlign.CENTER});
        glyph.connect('repaint', area => {
            const cr = area.get_context();
            drawGlyph(cr, provider.glyph, L.glyphSize / 2, L.glyphSize / 2, L.glyphSize);
            cr.$dispose();
        });
        header.add_child(glyph);
        header.add_child(hspacer(L.headerGap));
        header.add_child(text(`${provider.displayName} Usage`, {size: L.titleFont, weight: 600}));
        add(header);

        const snapshot = state.snapshot;
        if (!snapshot) {
            add(spacer(L.headerToBlock));
            add(text(state.error?.message ?? 'Reading usage…', {color: Palette.textSecondary}));
        } else {
            snapshot.windows.forEach((window, index) => {
                add(spacer(index === 0 ? L.headerToBlock : L.blockSpacing));
                const reset = window.resetsAt ? resetText(window.resetsAt, now) : '';
                add(splitRow(text(window.label), text(reset, {color: Palette.textSecondary})));
                add(spacer(L.labelToBar));
                add(usageBar(window.usedFraction));
                add(spacer(L.barToUsed));
                add(text(`${percentText(window.usedFraction)} Used`));
            });
            if (state.status !== 'ok') {
                add(spacer(L.blockSpacing));
                add(text(`Couldn't refresh · last read ${elapsedText(new Date(snapshot.fetchedAt), now)} ago`,
                    {color: Palette.textSecondary}));
            }
        }

        if (activity) {
            const rank = s => s.state === 'waiting' ? 0 : s.state === 'busy' ? 1 : 2;
            const ordered = [...activity.sessions].sort((a, b) => rank(a) - rank(b) || b.since - a.since);
            const shown = ordered.slice(0, L.sessionCap);
            add(spacer(L.blockSpacing));
            add(new St.Widget({width: L.cardTextWidth, height: L.hairline, reactive: false,
                style: `background-color: ${Palette.ringTrack};`}));
            for (const session of shown) {
                const color = session.state === 'busy' ? Palette.ample
                    : session.state === 'waiting' ? Palette.watch : Palette.textSecondary;
                const word = session.state === 'busy' ? 'working' : session.state;
                add(spacer(L.blockSpacing));
                const lead = new St.BoxLayout({reactive: false});
                lead.add_child(new StatusDot(color));
                lead.add_child(hspacer(L.statusDotGap));
                lead.add_child(text(session.name));
                add(splitRow(lead, text(word, {color})));
                add(spacer(L.sessionRowGap));
                const detail = session.state === 'waiting' && session.waitingFor
                    ? session.waitingFor : session.detail;
                add(splitRow(text(detail, {color: Palette.textSecondary}),
                    text(elapsedText(new Date(session.since), now), {color: Palette.textSecondary})));
            }
            if (ordered.length > shown.length) {
                add(spacer(L.blockSpacing));
                add(text(`and ${ordered.length - shown.length} more`, {color: Palette.textSecondary}));
            }
        }

        const [, natural] = this._content.get_preferred_height(L.cardTextWidth);
        const cardHeight = Math.ceil(natural + 2 * L.cardPadding);
        const width = Math.ceil(L.cardWidth + (this._vertical ? L.tailLength : 0));
        const height = Math.ceil(cardHeight + (this._vertical ? 0 : L.tailLength));
        this._bg.set_size(width, height);
        this.set_size(width, height);
    }
});

export class Notch {
    constructor(providers, {
        edge = 'right', position = 0.5, alwaysOpen = false,
        hideInFullscreen = true, refreshInterval = 60,
    } = {}) {
        this._providers = providers;
        this._edge = TAIL_SIDE[edge] ? edge : 'right';
        this._vertical = this._edge === 'left' || this._edge === 'right';
        this._position = clamp(position, 0, 1);
        this._alwaysOpen = alwaysOpen;
        this._hideInFullscreen = hideInFullscreen;
        this._refreshInterval = Math.max(15, refreshInterval);

        this._states = new Map(providers.map(p => [p.id, {
            snapshot: null, status: 'error', error: null, fetching: false,
        }]));
        this._sessions = new Map();
        this._cells = [];
        this._expanded = false;
        this._hoverIndex = -1;
        this._cardShown = false;
        this._leaveAt = 0;
        this._pollTimer = 0;
        this._refreshTimer = 0;
        this._cardTimer = 0;
        this._sessionMonitors = [];
        this.pinned = alwaysOpen;
    }

    get cellCount() {
        return this._cells.length;
    }

    enable() {
        const fixed = () => new Clutter.FixedLayout();
        this._visual = new St.Widget({layout_manager: fixed(), reactive: false});
        this._shape = new ShapeArea(this._edge);
        this._cellsGroup = new St.Widget({layout_manager: fixed(), reactive: false});
        this._visual.add_child(this._shape);
        this._visual.add_child(this._cellsGroup);
        for (const provider of this._providers) {
            const cell = new Cell(provider, this._vertical);
            this._cells.push(cell);
            this._cellsGroup.add_child(cell);
        }

        // Two actors on purpose: the drawing covers the whole envelope the
        // unfold can overshoot into, while the hit box is only ever as big as
        // the black actually is — so clicks beside a folded pill reach the
        // window underneath. Input goes wherever a reactive actor is and
        // passes through everywhere else, so nothing in the drawing tree is
        // reactive. The card is not tracked: tracking would have the layout
        // manager toggle its visibility, which is ours to decide.
        this._hit = new St.Widget({reactive: true, track_hover: true});
        this._card = new Card(TAIL_SIDE[this._edge]);
        for (const actor of [this._visual, this._hit]) {
            Main.layoutManager.addChrome(actor, {
                affectsStruts: false, trackFullscreen: this._hideInFullscreen,
            });
        }
        Main.layoutManager.uiGroup.add_child(this._card);

        this._hit.connect('enter-event', () => {
            this._expand();
            return Clutter.EVENT_PROPAGATE;
        });
        this._hit.connect('button-press-event', () => {
            this._openHoveredProvider();
            return Clutter.EVENT_STOP;
        });
        this._card.connect('button-press-event', () => {
            this._openHoveredProvider();
            return Clutter.EVENT_STOP;
        });

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._relayout());
        this._workareasChangedId = global.display.connect('workareas-changed', () => this._relayout());
        // The stage can tear the actors down without disable() being called.
        this._visual.connect('destroy', () => this._stopTimers());
        this._relayout();

        for (const provider of this._providers) {
            if (!provider.tracksSessions)
                continue;
            const monitor = new ClaudeSessionMonitor(provider.sessionsDir, sessions => {
                this._sessions.set(provider.id, sessions);
                this._applyState(provider.id);
            });
            monitor.start();
            this._sessions.set(provider.id, monitor.sessions);
            this._sessionMonitors.push(monitor);
        }

        for (const cell of this._cells)
            cell.update(this._states.get(cell.provider.id), this._activity(cell.provider.id));
        this._refreshAll();
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._refreshInterval, () => {
            this._refreshAll();
            return GLib.SOURCE_CONTINUE;
        });

        if (this._alwaysOpen)
            this._expand();
    }

    _stopTimers() {
        this._stopPolling();
        if (this._refreshTimer)
            GLib.source_remove(this._refreshTimer);
        if (this._cardTimer)
            GLib.source_remove(this._cardTimer);
        this._refreshTimer = this._cardTimer = 0;
        for (const monitor of this._sessionMonitors)
            monitor.stop();
        this._sessionMonitors = [];
    }

    destroy() {
        this._stopTimers();
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        if (this._workareasChangedId)
            global.display.disconnect(this._workareasChangedId);
        this._monitorsChangedId = this._workareasChangedId = 0;
        for (const actor of [this._hit, this._visual])
            Main.layoutManager.removeChrome(actor);
        for (const actor of [this._card, this._hit, this._visual])
            actor.destroy();
        this._card = this._hit = this._visual = null;
        this._cells = [];
    }

    // Geometry. Everything is reasoned about as (along, across): along the
    // edge from the work area's start, and across from the edge into the
    // screen. `_place` turns that into screen coordinates.

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        // The work area, not the monitor: that is what keeps a top notch
        // below the panel and a bottom one resting on top of a dock.
        const work = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        this._monitor = monitor;
        this._work = work;

        const V = this._vertical;
        const depth = bodyDepth(V);
        const full = shapeLength(this._cells.length, V);
        const envAcross = depth + L.envelopeMargin;
        const envAlong = full + 2 * L.envelopeSlack;

        const alongMin = V ? work.y : work.x;
        const alongLen = V ? work.height : work.width;
        const centre = clamp(alongMin + this._position * alongLen,
            alongMin + full / 2, alongMin + alongLen - full / 2);
        this._shapeStart = Math.round(centre - full / 2);
        this._shapeLength = full;
        this._depth = depth;
        this._edgeCoord = {
            right: work.x + work.width,
            left: work.x,
            top: work.y,
            bottom: work.y + work.height,
        }[this._edge];

        const envStart = this._shapeStart - L.envelopeSlack;
        const [ex, ey] = this._place(envStart, 0, envAlong, envAcross);
        this._visual.set_size(V ? envAcross : envAlong, V ? envAlong : envAcross);
        this._visual.set_position(ex, ey);
        this._shape.set_size(this._visual.width, this._visual.height);
        this._shape.fullLength = full;
        this._shape.fullDepth = depth;
        this._shape.queue_repaint();
        this._cellsGroup.set_size(this._visual.width, this._visual.height);

        // Cells, in the envelope's own coordinates.
        const outward = this._edge === 'right' || this._edge === 'bottom';
        this._cells.forEach((cell, i) => {
            const along = L.envelopeSlack + ringCenter(i, V) - L.ringDiameter / 2;
            const across = V ? 0 : L.ringMargin;
            const acrossPos = outward ? envAcross - depth + across : across;
            if (V)
                cell.set_position(acrossPos, along);
            else
                cell.set_position(along, acrossPos);
        });

        this._updateHitBox();
        if (this._cardShown && this._hoverIndex >= 0)
            this._placeCard(this._hoverIndex, false);
    }

    // Screen position of a box `alongSize` x `acrossSize` whose near side is
    // `across` from the edge and which starts `along` along it.
    _place(along, across, alongSize, acrossSize) {
        switch (this._edge) {
        case 'right': return [this._edgeCoord - across - acrossSize, along];
        case 'left': return [this._edgeCoord + across, along];
        case 'top': return [along, this._edgeCoord + across];
        case 'bottom': return [along, this._edgeCoord - across - acrossSize];
        }
        return [0, 0];
    }

    _updateHitBox() {
        let along;
        let alongSize;
        let acrossSize;
        if (this._expanded) {
            along = this._shapeStart;
            alongSize = this._shapeLength;
            acrossSize = this._depth;
        } else {
            alongSize = L.pillHeight + 2 * 10;
            along = this._shapeStart + (this._shapeLength - alongSize) / 2;
            acrossSize = L.pillHotZone;
        }
        const [x, y] = this._place(along, 0, alongSize, acrossSize);
        this._hit.set_size(this._vertical ? acrossSize : alongSize, this._vertical ? alongSize : acrossSize);
        this._hit.set_position(x, y);
    }

    // Along coordinate of a ring's centre, on screen.
    _ringAlong(index) {
        return this._shapeStart + ringCenter(index, this._vertical);
    }

    // Folding

    _expand() {
        if (this._expanded)
            return;
        this._expanded = true;
        this._leaveAt = 0;
        this._shape.remove_transition('progress');
        this._shape.ease_property('progress', 1, Motion.unfold);
        this._cells.forEach((cell, i) => {
            cell.remove_all_transitions();
            cell.ease({opacity: 255, delay: Motion.stagger(i), ...Motion.contents});
        });
        this._updateHitBox();
        this._startPolling();
        this._refreshAll(STALE_AFTER);
    }

    _collapse() {
        if (!this._expanded || this._alwaysOpen)
            return;
        this._expanded = false;
        this._hideCard();
        this._shape.remove_transition('progress');
        this._shape.ease_property('progress', 0, Motion.fold);
        for (const cell of this._cells) {
            cell.remove_all_transitions();
            cell.ease({opacity: 0, ...Motion.crossfade});
        }
        this._updateHitBox();
        this._stopPolling();
    }

    _startPolling() {
        if (this._pollTimer)
            return;
        this._pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollTimer)
            GLib.source_remove(this._pollTimer);
        this._pollTimer = 0;
    }

    _inside(x, y, rect) {
        return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
    }

    _poll() {
        const [x, y] = global.get_pointer();
        const V = this._vertical;

        // The body, with a little slack on its inner side.
        const [nx, ny] = this._place(this._shapeStart, 0, this._shapeLength, this._depth + EDGE_MARGIN);
        const notchRect = V
            ? [nx, ny, nx + this._depth + EDGE_MARGIN, ny + this._shapeLength]
            : [nx, ny, nx + this._shapeLength, ny + this._depth + EDGE_MARGIN];
        const inNotch = this._inside(x, y, notchRect);

        // The card, extended across the gap to the body so the pointer can
        // cross without the whole thing folding.
        let inCard = false;
        if (this._cardShown) {
            const card = this._card;
            const rect = [card.x, card.y, card.x + card.width, card.y + card.height];
            switch (this._edge) {
            case 'right': rect[2] = this._edgeCoord - this._depth; break;
            case 'left': rect[0] = this._edgeCoord + this._depth; break;
            case 'top': rect[1] = this._edgeCoord + this._depth; break;
            case 'bottom': rect[3] = this._edgeCoord - this._depth; break;
            }
            inCard = this._inside(x, y, rect);
        }

        if (inNotch || inCard || this.pinned) {
            this._leaveAt = 0;
            if (inNotch) {
                const along = V ? y : x;
                const pitch = cellPitch(V);
                const index = this._cells.findIndex((_, i) => Math.abs(along - this._ringAlong(i)) <= pitch / 2);
                if (index >= 0 && index !== this._hoverIndex)
                    this._showCard(index);
            }
            // Always open: the card still goes away when the pointer does.
            if (!inNotch && !inCard && this._cardShown && this._alwaysOpen && !this._debugPinned)
                this._hideCardAfterGrace();
            return;
        }
        this._hideCardAfterGrace(() => this._collapse());
    }

    _hideCardAfterGrace(then) {
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._leaveAt) {
            this._leaveAt = now;
        } else if (now - this._leaveAt > LEAVE_GRACE) {
            this._hideCard();
            then?.();
        }
    }

    // The card

    _showCard(index) {
        const wasShown = this._cardShown;
        this._hoverIndex = index;
        this._cardShown = true;
        if (!wasShown) {
            // Shown before it is filled: St cannot measure text that is not
            // on a visible branch of the stage, and it is invisible anyway.
            this._card.opacity = 0;
            this._card.show();
        }
        this._populateCard();
        this._placeCard(index, wasShown);
        if (!wasShown)
            this._card.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (!this._cardTimer) {
            this._cardTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CARD_TICK, () => {
                if (this._cardShown && this._hoverIndex >= 0) {
                    this._populateCard();
                    this._placeCard(this._hoverIndex, false);
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _populateCard() {
        const provider = this._cells[this._hoverIndex].provider;
        this._card.populate(provider, this._states.get(provider.id), this._activity(provider.id));
    }

    _placeCard(index, animate) {
        const work = this._work;
        const V = this._vertical;
        const card = this._card;
        const ringAlong = this._ringAlong(index);
        const alongSize = V ? card.height : card.width;
        const acrossSize = V ? card.width : card.height;
        const alongMin = (V ? work.y : work.x) + EDGE_MARGIN;
        const alongMax = (V ? work.y + work.height : work.x + work.width) - EDGE_MARGIN - alongSize;
        const along = Math.round(clamp(ringAlong - alongSize / 2, alongMin, alongMax));
        const [x, y] = this._place(along, this._depth + L.tailGap, alongSize, acrossSize);
        card.setTip(ringAlong - along);
        card.remove_all_transitions();
        if (animate)
            card.ease({x, y, ...Motion.glide});
        else
            card.set_position(x, y);
    }

    _hideCard() {
        this._hoverIndex = -1;
        if (this._cardTimer)
            GLib.source_remove(this._cardTimer);
        this._cardTimer = 0;
        if (!this._cardShown)
            return;
        this._cardShown = false;
        this._card.remove_all_transitions();
        this._card.ease({
            opacity: 0, ...Motion.crossfade,
            onComplete: () => this._card.hide(),
        });
    }

    _openHoveredProvider() {
        if (this._hoverIndex < 0)
            return;
        const url = this._cells[this._hoverIndex].provider.manageURL;
        if (url)
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
    }

    // Readings

    _activity(providerID) {
        return summarize(this._sessions.get(providerID));
    }

    _refreshAll(olderThan = 0) {
        const now = Date.now();
        for (const provider of this._providers) {
            const state = this._states.get(provider.id);
            if (olderThan && state.snapshot && now - state.snapshot.fetchedAt < olderThan)
                continue;
            this._refresh(provider).catch(e => console.error(`codenotch: ${e}`));
        }
    }

    async _refresh(provider) {
        const state = this._states.get(provider.id);
        if (state.fetching)
            return;
        state.fetching = true;
        try {
            const snapshot = await provider.fetch();
            state.snapshot = {...snapshot, fetchedAt: Date.now()};
            state.status = 'ok';
            state.error = null;
        } catch (e) {
            state.error = e;
            state.status = state.snapshot ? 'stale' : 'error';
            console.warn(`codenotch: ${provider.id}: ${e.message}`);
        } finally {
            state.fetching = false;
        }
        this._applyState(provider.id);
    }

    _applyState(providerID) {
        if (!this._visual)
            return;
        const index = this._cells.findIndex(c => c.provider.id === providerID);
        if (index < 0)
            return;
        this._cells[index].update(this._states.get(providerID), this._activity(providerID));
        if (this._cardShown && this._hoverIndex === index) {
            this._populateCard();
            this._placeCard(index, false);
        }
    }

    // Driven from the screenshot harness (dev/nested.sh).

    debugExpand() {
        this.pinned = true;
        this._debugPinned = true;
        this._expand();
    }

    debugHover(index) {
        this.pinned = true;
        this._debugPinned = true;
        if (index < this._cells.length)
            this._showCard(index);
    }
}
