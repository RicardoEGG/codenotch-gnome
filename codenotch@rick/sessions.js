// Watches ~/.claude/sessions and reports the Claude Code sessions that are
// actually running. Claude Code writes <pid>.json the moment its state changes,
// so the directory is watched rather than polled; a slow timer runs alongside
// purely to notice processes that died without touching the directory.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {readJSON} from './providers/http.js';

const LIVENESS_INTERVAL = 5;

export class ClaudeSessionMonitor {
    constructor(directory, onChange) {
        this._directory = directory;
        this._onChange = onChange;
        this._sessions = [];
        this._monitor = null;
        this._timer = 0;
        this._debounce = 0;
    }

    get sessions() {
        return this._sessions;
    }

    start() {
        this._rescan();
        try {
            const file = Gio.File.new_for_path(this._directory);
            this._monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._scheduleRescan());
        } catch {
            this._monitor = null; // no directory yet; the timer still covers us
        }
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LIVENESS_INTERVAL, () => {
            this._rescan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._debounce) {
            GLib.source_remove(this._debounce);
            this._debounce = 0;
        }
        this._monitor?.cancel();
        this._monitor = null;
    }

    // A single state change produces several file events; coalesce them.
    _scheduleRescan() {
        if (this._debounce)
            GLib.source_remove(this._debounce);
        this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._debounce = 0;
            this._rescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rescan() {
        const found = readSessions(this._directory);
        if (JSON.stringify(found) === JSON.stringify(this._sessions))
            return;
        this._sessions = found;
        this._onChange?.(found);
    }
}

export function readSessions(directory) {
    let names = [];
    try {
        const dir = Gio.File.new_for_path(directory);
        const it = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = it.next_file(null)))
            names.push(info.get_name());
        it.close(null);
    } catch {
        return [];
    }
    const sessions = [];
    for (const name of names) {
        if (!name.endsWith('.json'))
            continue;
        const json = readJSON(`${directory}/${name}`);
        const record = decode(json);
        if (record && isAlive(record.pid, record.procStart))
            sessions.push(record.session);
    }
    sessions.sort((a, b) => b.since - a.since);
    return sessions;
}

// ClaudeSessionRecord.swift, decoded leniently: an unknown field must never
// cost us a session we could have shown.
function decode(json) {
    if (!json || typeof json.pid !== 'number' || typeof json.cwd !== 'string')
        return null;
    const raw = json.status;
    const tempo = json.tempo;
    let state = 'idle';
    if (tempo === 'blocked' || raw === 'waiting')
        state = 'waiting';
    else if (tempo === 'active' || raw === 'busy')
        state = 'busy';

    const millis = json.statusUpdatedAt ?? json.updatedAt;
    const folder = json.cwd.split('/').filter(Boolean).pop() ?? json.cwd;
    return {
        pid: json.pid,
        procStart: typeof json.procStart === 'string' ? json.procStart : null,
        session: {
            id: `claude.${json.pid}`,
            name: json.name ?? folder,
            detail: `${surface(json.entrypoint)} · ${folder}`,
            state,
            waitingFor: json.waitingFor ?? json.needs ?? null,
            since: typeof millis === 'number' ? millis : Date.now(),
        },
    };
}

function surface(entrypoint) {
    switch (entrypoint) {
    case 'claude-desktop':
    case 'claude-desktop-3p': return 'Desktop';
    case 'claude-vscode': return 'VS Code';
    case 'local-agent': return 'Agent';
    default: return 'Terminal';
    }
}

// On Linux Claude Code records `procStart` as the process's start time in
// clock ticks — field 22 of /proc/<pid>/stat — which tells a live session
// from a file a crashed one left behind under a recycled pid.
function isAlive(pid, procStart) {
    if (!GLib.file_test(`/proc/${pid}`, GLib.FileTest.IS_DIR))
        return false;
    if (!procStart || !/^\d+$/.test(procStart))
        return true;
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        if (!ok)
            return true;
        const stat = new TextDecoder().decode(bytes);
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        // `rest[0]` is field 3 (state); field 22 is rest[19].
        return rest[19] === procStart;
    } catch {
        return true;
    }
}

// ActivitySummary.swift: one word for a provider's sessions.
export function summarize(sessions) {
    if (!sessions || sessions.length === 0)
        return null;
    let state = 'idle';
    if (sessions.some(s => s.state === 'waiting'))
        state = 'waiting';
    else if (sessions.some(s => s.state === 'busy'))
        state = 'working';
    return {state, sessions};
}
