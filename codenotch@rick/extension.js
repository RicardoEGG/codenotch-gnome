import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';
import {configureLayout, Appearance} from './layout.js';
import {ClaudeProvider} from './providers/claude.js';
import {CodexProvider} from './providers/codex.js';
import {shutdown as shutdownHttp} from './providers/http.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

export default class CodenotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect('changed', () => this._scheduleRebuild());
        this._rebuildTimer = 0;
        this._build();

        const shot = GLib.getenv('CODENOTCH_SHOT');
        if (shot)
            this._runShotScript(shot).catch(e => console.error(`codenotch: ${e}`));
    }

    disable() {
        this._shotCancelled = true;
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = 0;
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._settings = null;
        this._notch?.destroy();
        this._notch = null;
        shutdownHttp();
    }

    // Every preference changes geometry that is baked into actors at
    // construction, so the whole surface is rebuilt — cheaply, and only once
    // per burst of changes from a slider.
    _scheduleRebuild() {
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildTimer = 0;
            this._build();
            return GLib.SOURCE_REMOVE;
        });
    }

    _build() {
        const s = this._settings;
        this._notch?.destroy();

        configureLayout({scale: s.get_double('scale'), showLabels: s.get_boolean('show-labels')});
        Appearance.color = s.get_string('color');
        Appearance.opacity = s.get_double('opacity');

        // Only the tools that are signed in on this machine get a cell.
        const providers = [new ClaudeProvider(), new CodexProvider()].filter(p => p.available());
        this._notch = new Notch(providers, {
            edge: s.get_string('edge'),
            position: s.get_double('position'),
            alwaysOpen: s.get_boolean('always-open'),
            hideInFullscreen: s.get_boolean('hide-in-fullscreen'),
            refreshInterval: s.get_int('refresh-interval'),
        });
        this._notch.enable();
    }

    // Screenshots of each state, for the headless test harness.
    async _runShotScript(prefix) {
        const delay = ms => new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
        const shoot = async name => {
            const shooter = new Shell.Screenshot();
            const file = Gio.File.new_for_path(`${prefix}-${name}.png`);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            await shooter.screenshot(false, stream);
            stream.close(null);
            console.log(`codenotch: shot ${name}`);
        };

        await delay(5000);
        if (this._shotCancelled)
            return;
        Main.overview.hide();
        await delay(1000);
        await shoot('rest');
        this._notch.debugExpand();
        await delay(1500);
        await shoot('open');
        for (let i = 0; i < this._notch.cellCount; i++) {
            this._notch.debugHover(i);
            await delay(1200);
            await shoot(`hover${i}`);
        }
        const late = Number(GLib.getenv('CODENOTCH_SHOT_LATE'));
        if (late > 0) {
            await delay(late);
            await shoot('late');
        }
        console.log('codenotch: shots done');
    }
}
