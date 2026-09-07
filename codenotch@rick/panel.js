// The same readings as a top panel indicator: each tool's mark and the
// percent it has burned, in the shape of the battery's "88%". Hovering it
// drops a notch out of the panel; a click pins that notch open.
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Palette, setColor, band, bandColor} from './layout.js';
import {drawGlyph} from './glyphs.js';
import {percentText} from './copy.js';
import {headlineOf} from './store.js';

// Panel type is the shell's, so only the mark is measured here: a 14 px glyph
// with room around it for the activity arc to orbit on an 18 px circle.
const GLYPH_BOX = 20;
const GLYPH_SIZE = 14;
const ORBIT_RADIUS = 9;
const ORBIT_STROKE = 1.5;
const GLYPH_LABEL_GAP = 4;
const PROVIDER_GAP = 10;

// The provider's mark, with the activity indicator orbiting it: a short arc
// going round while the tool works, a pulsing ring while it waits on you.
const IndicatorGlyph = GObject.registerClass(
class IndicatorGlyph extends St.DrawingArea {
    _init(glyph) {
        super._init({
            width: GLYPH_BOX, height: GLYPH_BOX, reactive: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._glyph = glyph;
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
        const [w, h] = this.get_surface_size();
        drawGlyph(cr, this._glyph, w / 2, h / 2, GLYPH_SIZE);
        if (this._state) {
            cr.setLineWidth(ORBIT_STROKE);
            if (this._state === 'working') {
                setColor(cr, Palette.textPrimary);
                cr.setLineCap(1); // round
                const start = -Math.PI / 2 + this._phase * 2 * Math.PI;
                cr.arc(w / 2, h / 2, ORBIT_RADIUS, start, start + Math.PI / 2);
            } else {
                setColor(cr, Palette.watch, 1 - 0.7 * this._phase);
                cr.arc(w / 2, h / 2, ORBIT_RADIUS, 0, 2 * Math.PI);
            }
            cr.stroke();
        }
        cr.$dispose();
    }
});

function hspacer(width) {
    return new St.Widget({width, height: 1, reactive: false});
}

export const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    _init(store, {openDelay = 150} = {}) {
        // No menu: the notch dropping out of the panel is the menu.
        super._init(0.0, 'Codenotch', true);
        this._store = store;
        this._openDelay = Math.max(0, openDelay);
        this._notch = null;
        this._openTimer = 0;
        this._escapeID = 0;
        this._anchorIdle = 0;
        this._rows = new Map();

        const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, reactive: false});
        store.providers.forEach((provider, index) => {
            if (index > 0)
                box.add_child(hspacer(PROVIDER_GAP));
            const glyph = new IndicatorGlyph(provider.glyph);
            const label = new St.Label({
                text: '—',
                reactive: false,
                y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${Palette.textPrimary};`,
            });
            box.add_child(glyph);
            box.add_child(hspacer(GLYPH_LABEL_GAP));
            box.add_child(label);
            this._rows.set(provider.id, {glyph, label});
        });
        this.add_child(box);

        this._storeWatcher = store.connect(id => this._update(id));
        for (const provider of store.providers)
            this._update(provider.id);

        this.connect('notify::hover', () => this._onHover());
        this.connect('button-press-event', () => {
            this._togglePinned();
            return Clutter.EVENT_STOP;
        });
        this.connect('notify::allocation', () => this._reanchor());
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._reanchor());
        this.connect('destroy', () => this._onDestroyIndicator());
    }

    // The drop notch is built around this actor's geometry, so it is handed
    // over once the indicator is in the panel.
    setNotch(notch) {
        this._notch = notch;
        this._reanchor();
    }

    // Screen rect, for the notch's own pointer tracking: crossing the
    // indicator on the way down must not fold what the hover opened. Null
    // until the panel has laid the indicator out — before that the stage
    // transform is not a number.
    rect() {
        const [x, y] = this.get_transformed_position();
        const [w, h] = this.get_transformed_size();
        if (![x, y, w, h].every(Number.isFinite))
            return null;
        return [x, y, x + w, y + h];
    }

    centerX() {
        const box = this.rect();
        return box ? (box[0] + box[2]) / 2 : null;
    }

    // The allocation notification arrives mid-layout, when the transform is
    // still meaningless, so the reading is taken once the frame is over.
    _reanchor() {
        if (this._anchorIdle)
            return;
        this._anchorIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._anchorIdle = 0;
            this._reanchorNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reanchorNow() {
        const x = this.centerX();
        if (x !== null)
            this._notch?.setAnchor(x);
    }

    _update(providerID) {
        const row = this._rows.get(providerID);
        const state = this._store.stateOf(providerID);
        if (!row || !state)
            return;
        const fraction = headlineOf(state.snapshot)?.usedFraction ?? null;
        row.label.text = fraction === null ? '—' : percentText(fraction);
        row.label.style = `color: ${fraction === null ? Palette.textPrimary : bandColor(band(fraction))};`;
        // Dimming is about the reading's age; the activity beside it is known
        // first-hand and stays at full strength.
        row.label.opacity = state.status === 'ok' ? 255 : 115;
        const activity = this._store.activity(providerID);
        row.glyph.setState(activity?.state === 'idle' ? null : activity?.state ?? null);
    }

    // A brush past the indicator should not drop the notch, so the pointer
    // has to dwell on it — the same dwell the screen edge asks for.
    _onHover() {
        if (!this.hover) {
            this._cancelOpen();
            return;
        }
        if (this._openTimer || !this._notch)
            return;
        this._openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._openDelay, () => {
            this._openTimer = 0;
            if (!this.hover)
                return GLib.SOURCE_REMOVE;
            this._reanchorNow();
            this._notch?.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelOpen() {
        if (this._openTimer)
            GLib.source_remove(this._openTimer);
        this._openTimer = 0;
    }

    _cancelAnchor() {
        if (this._anchorIdle)
            GLib.source_remove(this._anchorIdle);
        this._anchorIdle = 0;
    }

    _togglePinned() {
        if (!this._notch)
            return;
        if (this._notch.isPinned) {
            this._unpin();
            return;
        }
        this._reanchorNow();
        this._notch.setPinned(true);
        this._notch.open();
        this._watchEscape(true);
    }

    _unpin() {
        this._watchEscape(false);
        this._notch?.setPinned(false);
        this._notch?.close();
    }

    // Only while pinned: an unconditional stage handler would swallow Escape
    // from everything else on the screen.
    _watchEscape(active) {
        if (active === !!this._escapeID)
            return;
        if (active) {
            this._escapeID = global.stage.connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                this._unpin();
                return Clutter.EVENT_STOP;
            });
        } else {
            global.stage.disconnect(this._escapeID);
            this._escapeID = 0;
        }
    }

    _onDestroyIndicator() {
        this._cancelOpen();
        this._cancelAnchor();
        this._watchEscape(false);
        if (this._storeWatcher)
            this._store.disconnect(this._storeWatcher);
        this._storeWatcher = 0;
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;
        this._notch = null;
    }
});
