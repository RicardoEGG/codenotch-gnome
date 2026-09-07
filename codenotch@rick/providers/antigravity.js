// Google Antigravity's CLI (`agy`) keeps its OAuth token in the GNOME keyring,
// with a stale copy on disk as a fallback. That token buys a plan name and,
// for a licensed account, the quota endpoint; an unlicensed one answers 403
// and the day's requests are counted from the transcripts `agy` leaves behind.
// Only `agy` ever refreshes the token — an hour old and it is dead — so an
// expired sign-in is not a failure here, just a reading without the network.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {request, home, exists, ProviderError} from './http.js';
import {readAntigravityActivity, AntigravityActivityMonitor} from '../sessions.js';

const LOAD_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const KEYRING_PREFIX = 'go-keyring-base64:';
const KEYRING_TIMEOUT = 3000;
const EXPIRED_NOTE = 'Sign-in expired · run agy to refresh';

export class AntigravityProvider {
    id = 'antigravity';
    displayName = 'Antigravity';
    glyph = 'antigravity';
    manageURL = 'https://antigravity.google';
    tracksSessions = true;

    constructor(cliRoot = home('.gemini', 'antigravity-cli'), ideRoot = home('.gemini', 'antigravity')) {
        this._roots = [cliRoot, ideRoot];
        this._brains = this._roots.map(root => `${root}/brain`);
        this._tokenPath = `${cliRoot}/antigravity-oauth-token`;
        this._retryNoEarlierThan = 0;
        this._tier = null;
    }

    // The 429 deadline, exposed so the notch can remember it across restarts.
    get backoffUntil() {
        return this._retryNoEarlierThan || null;
    }

    set backoffUntil(deadline) {
        this._retryNoEarlierThan = deadline ?? 0;
    }

    available() {
        return this._roots.some(exists);
    }

    account() {
        return {plan: this._tier ?? 'Personal', source: 'Antigravity'};
    }

    createSessionMonitor(onChange) {
        return new AntigravityActivityMonitor(this._brains, onChange);
    }

    async fetch() {
        const token = await this._token();
        if (token.expiresAt !== null && token.expiresAt <= Date.now())
            return this._local(EXPIRED_NOTE);
        if (this._retryNoEarlierThan > Date.now())
            throw new ProviderError('rateLimited', 'Antigravity asked us to wait before reading again');

        const load = await this._post(LOAD_ENDPOINT, token.accessToken, {metadata: {pluginType: 'GEMINI'}});
        if (load.status === 401 || load.status === 403)
            return this._local(EXPIRED_NOTE);
        if (load.status < 200 || load.status >= 300)
            throw new ProviderError('badResponse', `Antigravity answered HTTP ${load.status}`);
        this._retryNoEarlierThan = 0;
        this._tier = tierFrom(load.json) ?? this._tier;

        // Every account gets a plan name; only a licensed one gets numbers.
        const quota = await this._post(QUOTA_ENDPOINT, token.accessToken, {});
        const windows = quota.status >= 200 && quota.status < 300 ? windowsFrom(quota.json) : [];
        if (windows.length === 0)
            return this._local(null);
        return {windows, headlineID: windows[0].id, fidelity: 'official'};
    }

    // What the notch can say with no network at all: the model steps `agy`
    // logged today. There is no published ceiling to be a fraction of, so the
    // window carries a bare count and the ring stays empty.
    _local(note) {
        const {requestsToday} = readAntigravityActivity(this._brains);
        const snapshot = {
            windows: [{
                id: 'requests',
                label: 'Requests today · no limit published',
                usedFraction: null,
                used: requestsToday,
                resetsAt: null,
            }],
            headlineID: 'requests',
            fidelity: 'derived',
        };
        if (note)
            snapshot.note = note;
        return snapshot;
    }

    async _post(url, accessToken, body) {
        const {status, text, headers} = await request('POST', url, {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        }, JSON.stringify(body));
        if (status === 429) {
            const retry = Number(headers.get_one('Retry-After')) || 0;
            this._retryNoEarlierThan = Date.now() + Math.max(60, retry) * 1000;
            throw new ProviderError('rateLimited', 'Antigravity asked us to wait before reading again');
        }
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
        return {status, json};
    }

    async _token() {
        const raw = await keyringSecret() ?? fileSecret(this._tokenPath);
        const token = decodeCredential(raw)?.token;
        if (!token?.access_token) {
            throw new ProviderError('needsAuth',
                'Sign in to Antigravity (run `agy` once) to read your usage');
        }
        // A credential with no readable expiry is left to the server to judge.
        const expiry = token.expiry ? Date.parse(token.expiry) : NaN;
        return {
            accessToken: token.access_token,
            expiresAt: Number.isNaN(expiry) ? null : expiry,
        };
    }
}

let promisified = false;

// The Secret Service item `agy` writes: service=gemini, username=antigravity.
// Anything at all going wrong here — no libsecret, no session bus, a locked
// keyring — is answered with null so the file copy still gets its turn.
async function keyringSecret() {
    let timer = 0;
    try {
        const Secret = (await import('gi://Secret')).default;
        if (!promisified) {
            Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
            promisified = true;
        }
        const schema = Secret.Schema.new('org.freedesktop.Secret.Generic', Secret.SchemaFlags.NONE, {
            service: Secret.SchemaAttributeType.STRING,
            username: Secret.SchemaAttributeType.STRING,
        });
        // A keyring that is locked, or a Secret Service that has to be started
        // first, can leave the lookup outstanding for as long as it likes; the
        // stale file copy is worth more than an answer that never arrives.
        const cancellable = new Gio.Cancellable();
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEYRING_TIMEOUT, () => {
            timer = 0;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        return await Secret.password_lookup(schema,
            {service: 'gemini', username: 'antigravity'}, cancellable);
    } catch {
        return null;
    } finally {
        if (timer)
            GLib.source_remove(timer);
    }
}

function fileSecret(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

// go-keyring stores a value the Secret Service would mangle as base64 behind a
// marker prefix; the file copy is always the plain JSON.
function decodeCredential(raw) {
    if (!raw)
        return null;
    let text = raw.trim();
    if (text.startsWith(KEYRING_PREFIX)) {
        try {
            text = new TextDecoder().decode(GLib.base64_decode(text.slice(KEYRING_PREFIX.length)));
        } catch {
            return null;
        }
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function tierFrom(json) {
    const tiers = Array.isArray(json?.allowedTiers) ? json.allowedTiers : [];
    const current = json?.currentTier;
    if (current?.name)
        return current.name;
    const named = current?.id ? tiers.find(t => t?.id === current.id) : null;
    return (named ?? tiers.find(t => t?.isDefault) ?? tiers[0])?.name ?? null;
}

// The quota summary groups buckets by product; both shapes carry the same
// bucket, and a bucket only means anything with a ceiling to divide by.
export function windowsFrom(json) {
    if (!json)
        return [];
    const buckets = [];
    for (const group of json.quotaGroups ?? []) {
        for (const bucket of group?.buckets ?? [])
            buckets.push(bucket);
    }
    for (const bucket of json.buckets ?? [])
        buckets.push(bucket);

    const windows = [];
    for (const bucket of buckets) {
        const used = Number(bucket?.used);
        const limit = Number(bucket?.limit);
        if (!(limit > 0) || !Number.isFinite(used) || used < 0 || used > limit * 1.5)
            continue;
        const resetsAt = bucket.resetTime ? new Date(bucket.resetTime) : null;
        windows.push({
            id: bucket.name ?? bucket.displayName,
            label: bucket.displayName ?? bucket.name ?? 'Usage',
            usedFraction: used / limit,
            resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
        });
    }
    return windows;
}
