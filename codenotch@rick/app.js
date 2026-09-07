// Everything the extension is, assembled from the current preferences. The
// loader (extension.js) knows only this file: any surface added later is
// reached from here, sharing the one store so the readings are made once.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {configureLayout, Appearance} from './layout.js';
import {ClaudeProvider} from './providers/claude.js';
import {CodexProvider} from './providers/codex.js';
import {AntigravityProvider} from './providers/antigravity.js';
import * as http from './providers/http.js';
import {UsageStore} from './store.js';
import {Notch} from './notch.js';
import {PanelIndicator} from './panel.js';

const PANEL_ROLE = 'codenotch';

// The drop notch hangs from the panel itself, not from the work area: what is
// under the panel is the dock's or another extension's business.
function panelBottom() {
    const box = Main.layoutManager.panelBox;
    return box.y + box.height;
}

export function createApp(settings) {
    configureLayout({
        scale: settings.get_double('scale'),
        showLabels: settings.get_boolean('show-labels'),
        textScale: settings.get_double('text-scale'),
    });
    Appearance.color = settings.get_string('color');
    Appearance.opacity = settings.get_double('opacity');

    // Only the tools that are signed in on this machine get a cell.
    const providers = [new ClaudeProvider(), new CodexProvider(), new AntigravityProvider()]
        .filter(p => p.available());
    const store = new UsageStore(providers, {refreshInterval: settings.get_int('refresh-interval')});
    // Started before the views so they draw the remembered reading at once.
    store.start();

    const surface = settings.get_string('surface');
    const hideInFullscreen = settings.get_boolean('hide-in-fullscreen');
    const openDelay = settings.get_int('open-delay');
    const views = [];
    let edgeNotch = null;
    let dropNotch = null;

    if (surface !== 'panel') {
        edgeNotch = new Notch(store, {
            edge: settings.get_string('edge'),
            position: settings.get_double('position'),
            alwaysOpen: settings.get_boolean('always-open'),
            hideInFullscreen,
            hotZone: settings.get_int('hot-zone'),
            openDelay,
        });
        edgeNotch.enable();
        views.push(edgeNotch);
    }

    if (surface !== 'notch') {
        const indicator = new PanelIndicator(store, {openDelay});
        // A previous load that died without tearing down would keep the role.
        Main.panel.statusArea[PANEL_ROLE]?.destroy();
        Main.panel.addToStatusArea(PANEL_ROLE, indicator, 0, 'right');
        dropNotch = new Notch(store, {
            edge: 'top',
            anchor: indicator.centerX(),
            flare: 0,
            restHidden: true,
            restLength: () => indicator.width,
            edgeCoord: panelBottom,
            extraRects: () => [indicator.rect()],
            hideInFullscreen,
        });
        dropNotch.enable();
        indicator.setNotch(dropNotch);
        views.push(dropNotch, indicator);
    }

    // Screenshots are taken of whichever surface is the point of the run.
    const debugTarget = surface === 'panel' ? dropNotch : edgeNotch;

    return {
        get cellCount() {
            return debugTarget?.cellCount ?? 0;
        },
        destroy() {
            for (const view of views)
                view.destroy();
            store.destroy();
            http.shutdown();
        },
        debugExpand() {
            debugTarget?.debugExpand();
        },
        debugHover(index) {
            debugTarget?.debugHover(index);
        },
    };
}

// For a load the loader abandons before it ever builds an app.
export function shutdown() {
    http.shutdown();
}
