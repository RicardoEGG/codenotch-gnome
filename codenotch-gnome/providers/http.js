import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

let session = null;
const owned = new Map();

function getSession() {
    if (!session) {
        session = new Soup.Session({
            timeout: 15,
            user_agent: 'codenotch-gnome/0.1',
        });
    }
    return session;
}

// A session of one's own, for a caller that has to relax something the shared
// session must keep. Kept here rather than by the caller so that shutdown
// closes every socket the extension opened, and a caller asking again after
// one gets a live session instead of an abandoned one.
export function ownSession(name, options) {
    let own = owned.get(name);
    if (!own) {
        own = new Soup.Session(options);
        owned.set(name, own);
    }
    return own;
}

export function shutdown() {
    session?.abort();
    session = null;
    for (const own of owned.values())
        own.abort();
    owned.clear();
}

export async function request(method, url, headers = {}, body = null) {
    const msg = Soup.Message.new(method, url);
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.append(k, v);
    if (body !== null) {
        msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(body)));
    }
    const bytes = await getSession().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const data = bytes.get_data();
    return {
        // `status_code`, not `get_status()`: the latter hands back a Soup.Status
        // enum, and GJS refuses codes the enum lacks — 429 among them.
        status: msg.status_code,
        text: data ? new TextDecoder().decode(data) : '',
        headers: msg.get_response_headers(),
    };
}

export function readJSON(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

export function home(...parts) {
    return GLib.build_filenamev([GLib.get_home_dir(), ...parts]);
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

export class ProviderError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind; // 'needsAuth' | 'expired' | 'rateLimited' | 'offline' | 'badResponse' | 'network'
    }
}
