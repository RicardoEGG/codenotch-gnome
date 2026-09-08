// Antigravity's own language server, asked instead of Google.
//
// `cloudcode-pa` answers `retrieveUserQuotaSummary` with 403 "no valid license"
// for a personal account: the API judges which client is asking, and Codenotch
// cannot honestly claim to be Antigravity. Antigravity's own usage panel has
// the same problem and solves it the same way — it never calls Google either.
// It calls the language server running on this machine, which already holds
// both the credential and the client identity, and lets that make the call.
//
// So this is not a way around a locked door; it is the door Antigravity uses.
// It works only while `agy` or the IDE is running, which is honest: the figure
// comes from Antigravity, so Antigravity has to be there.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ownSession} from './http.js';

const SERVICE = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
// Antigravity is built on Codeium's stack and the header still says so. The
// CLI wants no token at all; the IDE's server refuses a request without one.
const CSRF_HEADER = 'x-codeium-csrf-token';
// `forceRefresh` is why this reads as live. The server keeps a quota cache and
// an empty request is served from it, so the figure would only move when
// something else refreshed it — in practice, opening Antigravity's own Models
// & Usage panel and pressing its button.
const BODY = '{"forceRefresh":true}';
const TIMEOUT = 5;

let cached = null;

// Every listening endpoint worth asking: the CLI, and the IDE's language
// server with the token it was started with.
export function discover() {
    const byInode = listeningPorts();
    const endpoints = [];
    for (const pid of processIDs()) {
        const token = tokenFor(pid);
        if (!token)
            continue;
        for (const port of portsOf(pid, byInode))
            endpoints.push({pid, port, csrf: token.csrf});
    }
    return endpoints;
}

export async function quota(endpoint) {
    const address = `127.0.0.1:${endpoint.port}${SERVICE}`;
    const plain = await post(`http://${address}`, endpoint.csrf);
    if (plain.status === 200)
        return windowsFrom(plain.text);
    // The server opens one plain port and one TLS port and never says which is
    // which; a plain request to the TLS one is answered with 400.
    if (plain.status !== 0 && plain.status !== 400)
        return [];
    const secure = await post(`https://${address}`, endpoint.csrf);
    return secure.status === 200 ? windowsFrom(secure.text) : [];
}

// The endpoint that answered last is tried first; a server restarted since
// then listens on new ports, so one failure buys one fresh scan.
export async function readQuota() {
    if (cached) {
        const windows = await quota(cached);
        if (windows.length > 0)
            return summarize(windows);
        cached = null;
    }
    const endpoints = discover();
    for (const endpoint of endpoints) {
        const windows = await quota(endpoint);
        if (windows.length > 0) {
            cached = endpoint;
            return summarize(windows);
        }
    }
    return {windows: [], headlineID: null, found: endpoints.length > 0};
}

// The five-hour window is the one that moves within a sitting, so it is the
// number the ring stands for when Gemini is in the answer at all.
function summarize(windows) {
    const has = id => windows.some(w => w.id === id);
    const headlineID = has('gemini-5h') ? 'gemini-5h'
        : has('gemini-weekly') ? 'gemini-weekly' : windows[0].id;
    return {windows, headlineID, found: true};
}

// The server reports what is left, not what is spent; the notch shows the
// opposite, so the fraction is inverted here rather than in the view, where
// its meaning would depend on the provider.
function windowsFrom(text) {
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        return [];
    }
    const windows = [];
    for (const group of json?.response?.groups ?? []) {
        for (const bucket of group?.buckets ?? []) {
            const remaining = Number(bucket?.remainingFraction);
            if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1)
                continue;
            const resetsAt = bucket.resetTime ? new Date(bucket.resetTime) : null;
            windows.push({
                id: bucket.bucketId ?? group.displayName ?? 'quota',
                label: labelFor(group, bucket),
                usedFraction: 1 - remaining,
                resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
            });
        }
    }
    return windows;
}

// The group names the models, the bucket names the window; on its own each is
// half a label, and the wire names ("Gemini Models · Five Hour Limit
// Remaining") wrap in the card and crowd the reset time, so both are cut to
// what a glance needs.
function labelFor(group, bucket) {
    const models = (group.displayName ?? '')
        .replace(/\s+models?$/i, '')
        .replace(/\s+and\s+/i, ' & ');
    const window = {weekly: 'Weekly', '5h': '5 hours'}[bucket.window] ??
        (bucket.displayName ?? '').replace(/\s*Limit\s*Remaining$/, '');
    const parts = [models, window].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : 'Usage';
}

async function post(url, csrf) {
    const msg = Soup.Message.new('POST', url);
    if (!msg)
        return {status: 0, text: ''};
    if (csrf)
        msg.request_headers.append(CSRF_HEADER, csrf);
    // The certificate is self-signed for 127.0.0.1 and the connection never
    // leaves the machine, so there is nothing a CA could attest to. This is
    // why the bridge keeps its own session: the shared one must not be taught
    // to trust anything.
    msg.connect('accept-certificate', () => true);
    msg.set_request_body_from_bytes('application/json',
        new GLib.Bytes(new TextEncoder().encode(BODY)));
    try {
        const bytes = await send(msg);
        const data = bytes.get_data();
        return {status: msg.status_code, text: data ? new TextDecoder().decode(data) : ''};
    } catch {
        // Nothing listening, or TLS refused: a status no server ever sends.
        return {status: 0, text: ''};
    }
}

// The callback form, so it works whether or not something else has already
// promisified `send_and_read_async` on the prototype.
function send(msg) {
    const session = ownSession('antigravity-bridge',
        {timeout: TIMEOUT, user_agent: 'codenotch-gnome/0.1'});
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (self, result) => {
            try {
                resolve(self.send_and_read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function processIDs() {
    const pids = [];
    let dir = null;
    try {
        dir = GLib.Dir.open('/proc', 0);
    } catch {
        return pids;
    }
    let name;
    while ((name = dir.read_name()) !== null) {
        if (/^\d+$/.test(name))
            pids.push(name);
    }
    dir.close();
    return pids;
}

// The CLI is known by its name; the IDE's server by the token on its command
// line, which is the only place that token is ever written down.
function tokenFor(pid) {
    if (readText(`/proc/${pid}/comm`)?.trim() === 'agy')
        return {csrf: null};
    const argv = readText(`/proc/${pid}/cmdline`)?.split('\0') ?? [];
    if (!argv.some(arg => arg.includes('language_server')))
        return null;
    const flag = argv.indexOf('--csrf_token');
    return flag >= 0 && argv[flag + 1] ? {csrf: argv[flag + 1]} : null;
}

// The port is chosen at runtime and never written down either, so it is read
// back from the kernel: the process's socket inodes, looked up in the table of
// listening sockets.
function portsOf(pid, byInode) {
    const ports = new Set();
    let dir = null;
    try {
        dir = GLib.Dir.open(`/proc/${pid}/fd`, 0);
    } catch {
        return [];
    }
    let name;
    while ((name = dir.read_name()) !== null) {
        let target = null;
        try {
            target = GLib.file_read_link(`/proc/${pid}/fd/${name}`);
        } catch {
            continue;
        }
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        const port = inode ? byInode.get(inode) : undefined;
        if (port !== undefined)
            ports.add(port);
    }
    dir.close();
    return [...ports];
}

// State 0A is LISTEN; the local port is the hex after the last colon.
function listeningPorts() {
    const byInode = new Map();
    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = readText(path);
        if (!text)
            continue;
        for (const line of text.split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields.length < 10 || fields[3] !== '0A')
                continue;
            const local = fields[1];
            const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 16);
            if (port > 0)
                byInode.set(fields[9], port);
        }
    }
    return byInode;
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}
