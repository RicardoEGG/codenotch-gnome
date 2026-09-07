// Every provider's last reading and its tool's live activity, in one place
// (UsageStore.swift). The surfaces that draw them — the edge notch, the panel
// indicator — are views onto this: they subscribe, and the readings are made
// once no matter how many of them are up.
import GLib from 'gi://GLib';

import {ClaudeSessionMonitor, summarize} from './sessions.js';
import {loadArchive, saveArchive} from './archive.js';

// Reading cadence: a provider is read every timer tick only while its tool is
// busy, otherwise only when nothing has been attempted for IDLE_REFRESH.
// Unfolding never reads. A reading older than STALE_AFTER is still shown,
// dimmed.
const IDLE_REFRESH = 5 * 60 * 1000;
const STALE_AFTER = 15 * 60 * 1000;

export class UsageStore {
    constructor(providers, {refreshInterval = 60} = {}) {
        this.providers = providers;
        this._refreshInterval = Math.max(15, refreshInterval);
        this._states = new Map(providers.map(p => [p.id, {
            snapshot: null, status: 'error', error: null, fetching: false, attemptedAt: 0,
        }]));
        this._archive = {};
        this._sessions = new Map();
        this._sessionMonitors = [];
        this._refreshTimer = 0;
        this._watchers = new Map();
        this._nextWatcherID = 1;
    }

    // A watcher is handed the provider's id whenever that provider's reading
    // or activity changed, and reads the new values back with stateOf and
    // activity — the same call a first draw makes, so views have one path.
    connect(callback) {
        const id = this._nextWatcherID++;
        this._watchers.set(id, callback);
        return id;
    }

    disconnect(id) {
        this._watchers.delete(id);
    }

    start() {
        this._restoreArchive();
        for (const provider of this.providers) {
            if (!provider.tracksSessions)
                continue;
            const monitor = new ClaudeSessionMonitor(provider.sessionsDir, sessions => {
                this._sessions.set(provider.id, sessions);
                this._notify(provider.id);
            });
            monitor.start();
            this._sessions.set(provider.id, monitor.sessions);
            this._sessionMonitors.push(monitor);
        }
        this._refreshAll('initial');
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._refreshInterval, () => {
            this._refreshAll('tick');
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._refreshTimer)
            GLib.source_remove(this._refreshTimer);
        this._refreshTimer = 0;
        for (const monitor of this._sessionMonitors)
            monitor.stop();
        this._sessionMonitors = [];
        this._watchers.clear();
    }

    // The state with its status brought up to date by age, so a reading
    // crosses into 'stale' without anything having been fetched.
    stateOf(providerID, now = Date.now()) {
        const state = this._states.get(providerID);
        if (!state)
            return null;
        if (!state.snapshot)
            state.status = 'error';
        else
            state.status = now - state.snapshot.fetchedAt < STALE_AFTER ? 'ok' : 'stale';
        return state;
    }

    activity(providerID) {
        return summarize(this._sessions.get(providerID));
    }

    _notify(providerID) {
        for (const callback of [...this._watchers.values()])
            callback(providerID);
    }

    _restoreArchive() {
        this._archive = loadArchive();
        for (const provider of this.providers) {
            const entry = this._archive[provider.id];
            if (!entry)
                continue;
            const state = this._states.get(provider.id);
            state.snapshot = entry.snapshot;
            // The remembered reading counts as the last attempt: it is what
            // decides whether the first read can wait.
            state.attemptedAt = entry.snapshot?.fetchedAt ?? 0;
            provider.backoffUntil = entry.backoffUntil;
            this.stateOf(provider.id);
        }
    }

    _busy(providerID) {
        const state = this.activity(providerID)?.state;
        return state === 'working' || state === 'waiting';
    }

    // The first read at start() ignores activity: a remembered reading that is
    // still fresh is good enough to start from.
    _refreshAll(reason) {
        const now = Date.now();
        for (const provider of this.providers) {
            const state = this._states.get(provider.id);
            const before = state.status;
            const due = now - state.attemptedAt >= IDLE_REFRESH;
            if (due || (reason === 'tick' && this._busy(provider.id)))
                this._refresh(provider).catch(e => console.error(`codenotch: ${e}`));
            else if (this.stateOf(provider.id, now).status !== before)
                this._notify(provider.id);
        }
    }

    async _refresh(provider) {
        const state = this._states.get(provider.id);
        if (state.fetching)
            return;
        state.fetching = true;
        state.attemptedAt = Date.now();
        let read = false;
        try {
            const snapshot = await provider.fetch();
            state.snapshot = {...snapshot, fetchedAt: Date.now()};
            state.error = null;
            read = true;
        } catch (e) {
            state.error = e;
            console.warn(`codenotch: ${provider.id}: ${e.message}`);
        } finally {
            state.fetching = false;
        }
        this._remember(provider, read);
        this._notify(provider.id);
    }

    _remember(provider, read) {
        const entry = this._archive[provider.id] ??= {snapshot: null, backoffUntil: null};
        const state = this._states.get(provider.id);
        let changed = read;
        if (read)
            entry.snapshot = state.snapshot;
        if (entry.backoffUntil !== provider.backoffUntil) {
            entry.backoffUntil = provider.backoffUntil;
            changed = true;
        }
        if (changed)
            saveArchive(this._archive);
    }
}

// The one window a single number has to stand for.
export function headlineOf(snapshot) {
    if (!snapshot || snapshot.windows.length === 0)
        return null;
    return snapshot.windows.find(w => w.id === snapshot.headlineID) ?? snapshot.windows[0];
}
