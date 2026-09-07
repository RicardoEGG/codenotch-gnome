import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

// Modules the notch is built from. Everything else is reached through their
// static imports, which resolve relative to wherever these were loaded from.
const MODULES = ['notch.js', 'layout.js', 'providers/claude.js', 'providers/codex.js', 'providers/http.js'];
const LOADER_FILES = ['extension.js', 'prefs.js'];

// The shell never re-imports a module it has already seen, so editing the
// extension in place would need a new session to take effect. A module's
// identity is its URL, though: copying the source into a fresh directory and
// importing from there loads fresh code. This file is only the loader; the
// notch itself lives in whatever copy was imported last.
export default class CodenotchExtension extends Extension {
    enable() {
        this._enabled = true;
        this._generation = 0;
        this._mods = null;
        this._notch = null;
        this._rebuildTimer = 0;
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => this._onSettingsChanged(key));
        this._loading = this._load().catch(e => console.error(`codenotch: load failed: ${e}\n${e.stack ?? ''}`));

        const shot = GLib.getenv('CODENOTCH_SHOT');
        if (shot)
            this._runShotScript(shot).catch(e => console.error(`codenotch: ${e}`));
    }

    disable() {
        this._enabled = false;
        this._shotCancelled = true;
        // A load still in flight sees `_enabled` false when it resolves and
        // tears down what it imported instead of building.
        this._generation++;
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = 0;
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._settings = null;
        this._teardown();
    }

    _teardown() {
        this._notch?.destroy();
        this._notch = null;
        this._mods?.http.shutdown();
        this._mods = null;
    }

    _onSettingsChanged(key) {
        if (key !== 'reload-token') {
            this._scheduleRebuild();
            return;
        }
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = 0;
        this._teardown();
        this._loading = this._load().catch(e => console.error(`codenotch: reload failed: ${e}\n${e.stack ?? ''}`));
    }

    async _load() {
        const generation = ++this._generation;
        const dir = this._stageSource();
        const mods = {};
        for (const name of MODULES)
            mods[name] = await import(`file://${dir}/${name}`);
        // Everything an earlier load put here is already in memory.
        this._pruneStage(dir);

        if (!this._enabled || generation !== this._generation) {
            mods['providers/http.js'].shutdown();
            return;
        }
        this._mods = {
            notch: mods['notch.js'],
            layout: mods['layout.js'],
            claude: mods['providers/claude.js'],
            codex: mods['providers/codex.js'],
            http: mods['providers/http.js'],
        };
        this._build();
    }

    // Copies the extension's modules into a directory nobody has imported
    // from yet and returns its path.
    _stageSource() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'codenotch', 'live', String(Date.now())]);
        for (const sub of ['', 'providers']) {
            const src = Gio.File.new_for_path(GLib.build_filenamev([this.path, sub]));
            const dst = Gio.File.new_for_path(GLib.build_filenamev([dir, sub]));
            dst.make_directory_with_parents(null);
            const children = src.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (const info of children) {
                const name = info.get_name();
                if (!name.endsWith('.js') || (sub === '' && LOADER_FILES.includes(name)))
                    continue;
                src.get_child(name).copy(dst.get_child(name), Gio.FileCopyFlags.OVERWRITE, null, null);
            }
            children.close(null);
        }
        return dir;
    }

    _pruneStage(keep) {
        const live = Gio.File.new_for_path(keep).get_parent();
        const children = live.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (const info of children) {
            const child = live.get_child(info.get_name());
            if (child.get_path() !== keep)
                removeTree(child);
        }
        children.close(null);
    }

    // Every preference changes geometry that is baked into actors at
    // construction, so the whole surface is rebuilt — cheaply, and only once
    // per burst of changes from a slider.
    _scheduleRebuild() {
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildTimer = 0;
            // A load in flight builds from the current settings on its own.
            if (this._mods)
                this._build();
            return GLib.SOURCE_REMOVE;
        });
    }

    _build() {
        const s = this._settings;
        const {notch, layout, claude, codex} = this._mods;
        this._notch?.destroy();

        layout.configureLayout({
            scale: s.get_double('scale'),
            showLabels: s.get_boolean('show-labels'),
            textScale: s.get_double('text-scale'),
        });
        layout.Appearance.color = s.get_string('color');
        layout.Appearance.opacity = s.get_double('opacity');

        // Only the tools that are signed in on this machine get a cell.
        const providers = [new claude.ClaudeProvider(), new codex.CodexProvider()].filter(p => p.available());
        this._notch = new notch.Notch(providers, {
            edge: s.get_string('edge'),
            position: s.get_double('position'),
            alwaysOpen: s.get_boolean('always-open'),
            hideInFullscreen: s.get_boolean('hide-in-fullscreen'),
            refreshInterval: s.get_int('refresh-interval'),
            hotZone: s.get_int('hot-zone'),
            openDelay: s.get_int('open-delay'),
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

        await this._loading;
        await delay(5000);
        if (this._shotCancelled || !this._notch)
            return;
        Main.overview.hide();
        await delay(1000);
        await shoot('rest');
        this._notch.debugExpand();
        await delay(1500);
        await shoot('open');
        for (let i = 0; i < (this._notch?.cellCount ?? 0); i++) {
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

function removeTree(file) {
    const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (const info of children)
            removeTree(file.get_child(info.get_name()));
        children.close(null);
    }
    file.delete(null);
}
