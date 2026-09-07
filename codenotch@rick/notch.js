import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {L, Palette, setColor, band, bandColor, shapeLength, ringCenter} from './layout.js';
import {notchPath, cardPath} from './shape.js';
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

const REFRESH_INTERVAL = 60;      // seconds between usage reads
const STALE_AFTER = 20 * 1000;    // ms: unfolding re-reads anything older
const POLL_INTERVAL = 60;         // ms: pointer tracking while unfolded
const LEAVE_GRACE = 250;          // ms: the pointer has to cross the gap to the card
const CARD_TICK = 30;             // seconds between relative-time refreshes

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function doubleSpec(name, min, max, initial) {
    return GObject.ParamSpec.double(name, name, name,
        GObject.ParamFlags.READWRITE, min, max, initial);
}

// The notch body: pill at rest, unfolding to the full shape as `progress`
// goes 0 -> 1. Drawn flush with the actor's right edge, centred vertically.
const ShapeArea = GObject.registerClass({
    Properties: {'progress': doubleSpec('progress', -1, 2, 0)},
}, class ShapeArea extends St.DrawingArea {
    _init() {
        super._init({reactive: false});
        this._progress = 0;
        this.fullLength = L.pillHeight;
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
        const depth = lerp(L.pillWidth, L.bodyDepth, p);
        const length = lerp(L.pillHeight, this.fullLength, p);
        notchPath(cr, w - depth, (h - length) / 2, depth, length);
        setColor(cr, Palette.notch);
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

// A ring and the percent burned underneath it.
const Cell = GObject.registerClass(
class Cell extends St.Widget {
    _init(provider) {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            width: L.bodyDepth,
            height: L.cellExtent,
            opacity: 0,
            reactive: false,
        });
        this.provider = provider;
        this._ring = new RingArea(provider.glyph);
        this._ring.set_position(L.ringMargin, 0);
        this._activity = new ActivityArea();
        this._activity.set_position(L.ringMargin, 0);
        this._label = new St.Label({
            text: '—',
            reactive: false,
            width: L.bodyDepth,
            height: L.percentLineHeight,
            style: `font-size: ${L.percentFont.toFixed(1)}px; font-weight: 600; ` +
                   `color: ${Palette.textPrimary}; text-align: center;`,
        });
        this._label.set_position(0, L.ringDiameter + L.ringLabelGap);
        this.add_child(this._ring);
        this.add_child(this._activity);
        this.add_child(this._label);
    }

    update(state, activity) {
        const headline = headlineOf(state.snapshot);
        const fraction = headline?.usedFraction ?? null;
        this._ring.setReading(fraction);
        // Dimming applies to the usage reading only: whether the tool is
        // working right now is known first-hand and stays at full strength.
        this._ring.opacity = state.status === 'ok' ? 255 : 115;
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
    _init() {
        super._init();
        this.tipY = 0;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        cardPath(cr, 0, 0, w - L.tailLength, h, L.cardCorner, L.tailLength, L.tailHeight, this.tipY);
        setColor(cr, Palette.card);
        cr.fill();
        cr.$dispose();
    }
});

function text(str, {size = L.bodyFont, weight = 400, color = Palette.textPrimary} = {}) {
    const label = new St.Label({
        text: str,
        style: `font-size: ${size.toFixed(1)}px; font-weight: ${weight}; color: ${color};`,
    });
    label.clutter_text.line_wrap = true;
    return label;
}

function splitRow(leading, trailing) {
    const row = new St.BoxLayout({width: L.cardTextWidth});
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
    const track = new St.Widget({
        layout_manager: new Clutter.FixedLayout(),
        width: L.cardTextWidth,
        height: L.barHeight,
        style: `background-color: ${Palette.barTrack}; border-radius: ${(L.barHeight / 2).toFixed(1)}px;`,
    });
    const fill = new St.Widget({
        width: Math.max(L.barHeight, L.cardTextWidth * clamp(fraction, 0, 1)),
        height: L.barHeight,
        style: `background-color: ${bandColor(band(fraction))}; border-radius: ${(L.barHeight / 2).toFixed(1)}px;`,
    });
    track.add_child(fill);
    return track;
}

const StatusDot = GObject.registerClass(
class StatusDot extends St.DrawingArea {
    _init(color) {
        super._init({width: L.statusDot, height: L.statusDot, y_align: Clutter.ActorAlign.CENTER});
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
    _init() {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
            visible: false,
            opacity: 0,
        });
        this._bg = new CardBackground();
        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            width: L.cardTextWidth,
        });
        this._content.set_position(L.cardPadding, L.cardPadding);
        this.add_child(this._bg);
        this.add_child(this._content);
    }

    setTip(y) {
        this._bg.tipY = y;
        this._bg.queue_repaint();
    }

    populate(provider, state, activity, now = new Date()) {
        this._content.destroy_all_children();
        const add = actor => this._content.add_child(actor);

        const header = new St.BoxLayout({width: L.cardTextWidth});
        const glyph = new St.DrawingArea({width: L.glyphSize, height: L.glyphSize, y_align: Clutter.ActorAlign.CENTER});
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
            add(new St.Widget({width: L.cardTextWidth, height: L.hairline,
                style: `background-color: ${Palette.ringTrack};`}));
            for (const session of shown) {
                const color = session.state === 'busy' ? Palette.ample
                    : session.state === 'waiting' ? Palette.watch : Palette.textSecondary;
                const word = session.state === 'busy' ? 'working' : session.state;
                add(spacer(L.blockSpacing));
                const lead = new St.BoxLayout();
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
        const height = Math.ceil(natural + 2 * L.cardPadding);
        const width = Math.ceil(L.cardWidth + L.tailLength);
        this._bg.set_size(width, height);
        this.set_size(width, height);

    }
});

export class Notch {
    constructor(providers) {
        this._providers = providers;
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
        this.pinned = false;
    }

    enable() {
        const fixed = () => new Clutter.FixedLayout();
        this._visual = new St.Widget({layout_manager: fixed(), reactive: false});
        this._shape = new ShapeArea();
        this._cellsGroup = new St.Widget({layout_manager: fixed(), reactive: false});
        this._visual.add_child(this._shape);
        this._visual.add_child(this._cellsGroup);
        for (const provider of this._providers) {
            const cell = new Cell(provider);
            this._cells.push(cell);
            this._cellsGroup.add_child(cell);
        }

        // Two actors on purpose: the drawing covers the whole envelope the
        // unfold can overshoot into, while the hit box is only ever as big as
        // the black actually is — so clicks beside a folded pill reach the
        // window underneath.
        this._hit = new St.Widget({reactive: true, track_hover: true});
        this._card = new Card();

        // Input goes wherever a reactive actor is and passes through everywhere
        // else, so nothing in the drawing tree is reactive. The card is not
        // tracked: tracking would have the layout manager toggle its
        // visibility, which is ours to decide.
        for (const actor of [this._visual, this._hit])
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: true});
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

        this._cells.forEach((cell, i) => cell.update(this._states.get(cell.provider.id), this._activity(cell.provider.id)));
        this._refreshAll();
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
            this._refreshAll();
            return GLib.SOURCE_CONTINUE;
        });
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
        for (const actor of [this._hit, this._visual])
            Main.layoutManager.removeChrome(actor);
        for (const actor of [this._card, this._hit, this._visual])
            actor.destroy();
        this._card = this._hit = this._visual = null;
        this._cells = [];
    }

    // Geometry

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._monitor = monitor;
        const full = shapeLength(this._cells.length);
        const envW = L.bodyDepth + L.envelopeMargin;
        const envH = full + 2 * L.envelopeSlack;
        this._visual.set_size(envW, envH);
        this._visual.set_position(monitor.x + monitor.width - envW,
            monitor.y + Math.round((monitor.height - envH) / 2));
        this._shape.set_size(envW, envH);
        this._shape.fullLength = full;
        this._shape.queue_repaint();
        this._cellsGroup.set_size(envW, envH);
        this._cells.forEach((cell, i) => {
            cell.set_position(envW - L.bodyDepth, L.envelopeSlack + ringCenter(i) - L.ringDiameter / 2);
        });
        this._edgeX = monitor.x + monitor.width;
        this._shapeTop = this._visual.y + L.envelopeSlack;
        this._shapeLength = full;
        this._updateHitBox();
        if (this._cardShown && this._hoverIndex >= 0)
            this._placeCard(this._hoverIndex, false);
    }

    _updateHitBox() {
        if (this._expanded) {
            this._hit.set_size(L.bodyDepth, this._shapeLength);
            this._hit.set_position(this._edgeX - L.bodyDepth, this._shapeTop);
        } else {
            const height = L.pillHeight + 2 * 10;
            this._hit.set_size(L.pillHotZone, height);
            this._hit.set_position(this._edgeX - L.pillHotZone,
                this._shapeTop + (this._shapeLength - height) / 2);
        }
    }

    _ringY(index) {
        return this._shapeTop + ringCenter(index);
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
        if (!this._expanded)
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

    _poll() {
        const [x, y] = global.get_pointer();
        const inNotch = x >= this._edgeX - L.bodyDepth - 8 && x <= this._edgeX &&
            y >= this._shapeTop && y <= this._shapeTop + this._shapeLength;
        const card = this._card;
        const inCard = this._cardShown && x >= card.x && x <= this._edgeX - L.bodyDepth &&
            y >= card.y && y <= card.y + card.height;

        if (inNotch || inCard || this.pinned) {
            this._leaveAt = 0;
            if (inNotch) {
                const index = this._cells.findIndex((_, i) => Math.abs(y - this._ringY(i)) <= L.cellPitch / 2);
                if (index >= 0 && index !== this._hoverIndex)
                    this._showCard(index);
            }
            return;
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._leaveAt)
            this._leaveAt = now;
        else if (now - this._leaveAt > LEAVE_GRACE)
            this._collapse();
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
        const monitor = this._monitor;
        const height = this._card.height;
        const ringY = this._ringY(index);
        const x = Math.round(this._edgeX - L.bodyDepth - L.tailGap - this._card.width);
        const y = Math.round(clamp(ringY - height / 2, monitor.y + 8, monitor.y + monitor.height - height - 8));
        this._card.setTip(ringY - y);
        this._card.remove_all_transitions();
        if (animate)
            this._card.ease({x, y, ...Motion.glide});
        else
            this._card.set_position(x, y);
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
        this._expand();
    }

    debugHover(index) {
        this.pinned = true;
        if (index < this._cells.length)
            this._showCard(index);
    }
}
