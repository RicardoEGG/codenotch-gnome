import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';
import {ClaudeProvider} from './providers/claude.js';
import {CodexProvider} from './providers/codex.js';
import {shutdown as shutdownHttp} from './providers/http.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

export default class CodenotchExtension extends Extension {
    enable() {
        // Only the tools that are signed in on this machine get a cell.
        const providers = [new ClaudeProvider(), new CodexProvider()].filter(p => p.available());
        this._notch = new Notch(providers);
        this._notch.enable();

        const shot = GLib.getenv('CODENOTCH_SHOT');
        if (shot)
            this._runShotScript(shot, providers.length).catch(e => console.error(`codenotch: ${e}`));
    }

    disable() {
        this._shotCancelled = true;
        this._notch?.destroy();
        this._notch = null;
        shutdownHttp();
    }

    // Screenshots of each state, for the headless test harness.
    async _runShotScript(prefix, cellCount) {
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
        for (let i = 0; i < cellCount; i++) {
            this._notch.debugHover(i);
            await delay(1200);
            await shoot(`hover${i}`);
        }
        console.log('codenotch: shots done');
    }
}
