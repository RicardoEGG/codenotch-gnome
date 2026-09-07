import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

let session = null;

function getSession() {
    if (!session) {
        session = new Soup.Session({
            timeout: 15,
            user_agent: 'codenotch-gnome/0.1',
        });
    }
    return session;
}

export function shutdown() {
    session?.abort();
    session = null;
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
        status: msg.get_status(),
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
        this.kind = kind; // 'needsAuth' | 'expired' | 'rateLimited' | 'badResponse' | 'network'
    }
}
