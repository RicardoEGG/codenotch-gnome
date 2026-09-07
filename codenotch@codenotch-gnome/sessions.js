// What each tool is doing right now, read off the files it leaves behind.
// Claude Code writes ~/.claude/sessions/<pid>.json the moment its state
// changes, so that directory is watched rather than polled; a slow timer runs
// alongside purely to notice processes that died without touching it.
// Antigravity says nothing about itself, so its transcripts are polled.
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

// Antigravity keeps one directory per conversation under its brain root, each
// with a transcript of every step the model and the user took. Nothing on disk
// says whether `agy` is running, so a transcript written seconds ago is what
// stands for "working", and the model steps dated today are the day's requests.
const ANTIGRAVITY_POLL = 3;
const ANTIGRAVITY_BUSY_WINDOW = 45 * 1000;

// Transcripts run to hundreds of kilobytes and the busy check polls every few
// seconds, so a file is re-read only once its mtime — or the calendar day the
// count is for — has moved.
const transcriptCounts = new Map();

export function readAntigravityActivity(roots, now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const dayStart = start.getTime();
    const dayEnd = end.getTime();

    let requestsToday = 0;
    let lastRequest = null;
    for (const root of roots) {
        for (const name of childNames(root)) {
            const path = `${root}/${name}/.system_generated/logs/transcript.jsonl`;
            const modified = modifiedMillis(path);
            if (modified === null)
                continue;
            requestsToday += stepsToday(path, modified, dayStart, dayEnd);
            if (!lastRequest || modified > lastRequest.at)
                lastRequest = {id: name, at: modified};
        }
    }
    return {requestsToday, lastRequest};
}

export class AntigravityActivityMonitor {
    constructor(roots, onChange) {
        this._roots = roots;
        this._onChange = onChange;
        this._sessions = [];
        this._timer = 0;
    }

    get sessions() {
        return this._sessions;
    }

    start() {
        this._rescan();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ANTIGRAVITY_POLL, () => {
            this._rescan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _rescan() {
        const now = Date.now();
        const {lastRequest} = readAntigravityActivity(this._roots, now);
        const found = [];
        if (lastRequest && now - lastRequest.at < ANTIGRAVITY_BUSY_WINDOW) {
            found.push({
                id: `antigravity.${lastRequest.id}`,
                name: 'Antigravity',
                detail: 'Working',
                state: 'busy',
                waitingFor: null,
                since: lastRequest.at,
            });
        }
        if (JSON.stringify(found) === JSON.stringify(this._sessions))
            return;
        this._sessions = found;
        this._onChange?.(found);
    }
}

function childNames(directory) {
    const names = [];
    try {
        const dir = Gio.File.new_for_path(directory);
        const it = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = it.next_file(null))) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                names.push(info.get_name());
        }
        it.close(null);
    } catch {
        return [];
    }
    return names;
}

function modifiedMillis(path) {
    try {
        const info = Gio.File.new_for_path(path)
            .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_uint64('time::modified') * 1000;
    } catch {
        return null;
    }
}

function stepsToday(path, modified, dayStart, dayEnd) {
    const cached = transcriptCounts.get(path);
    if (cached && cached.modified === modified && cached.dayStart === dayStart)
        return cached.count;
    const count = countModelSteps(path, dayStart, dayEnd);
    transcriptCounts.set(path, {modified, dayStart, count});
    return count;
}

// `created_at` is UTC; the day it belongs to is the local one it lands in.
function countModelSteps(path, dayStart, dayEnd) {
    let text;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return 0;
        text = new TextDecoder().decode(bytes);
    } catch {
        return 0;
    }
    let count = 0;
    for (const line of text.split('\n')) {
        if (!line)
            continue;
        let step;
        try {
            step = JSON.parse(line);
        } catch {
            continue;
        }
        if (step?.source !== 'MODEL')
            continue;
        const at = Date.parse(step.created_at);
        if (at >= dayStart && at < dayEnd)
            count++;
    }
    return count;
}
