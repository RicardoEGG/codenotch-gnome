// xAI's Grok CLI signs in through auth.x.ai and leaves the session in
// ~/.grok/auth.json. Codenotch only reads it: refreshing is the CLI's job, and
// writing a token back would race it for the file. The billing endpoint states
// whatever the account has metered — on an account with nothing metered it
// answers 200 with zeros, and the day's turns counted off the session logs are
// all there is to show.
import {request, readJSON, home, exists, ProviderError} from './http.js';
import {readGrokActivity, GrokActivityMonitor} from '../sessions.js';

const CREDITS_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const LEDGER_ENDPOINT = 'https://cli-chat-proxy.grok.com/v1/billing';
// Grok also supports a customer IdP whose token is meant for a private proxy;
// sending that to the public endpoint would hand over someone else's credential.
const TRUSTED_ISSUER = 'https://auth.x.ai';
const EXPIRED_NOTE = 'Sign-in expired · run grok to refresh';
const NEEDS_AUTH = 'Sign in to Grok (run `grok login`) to read your usage';
const RATE_LIMITED = 'Grok asked us to wait before reading again';

export class GrokProvider {
    id = 'grok';
    displayName = 'Grok';
    glyph = 'grok';
    manageURL = 'https://grok.com/?_s=usage';
    tracksSessions = true;

    constructor(root = home('.grok')) {
        this._authPath = `${root}/auth.json`;
        this._activePath = `${root}/active_sessions.json`;
        this._sessionsRoot = `${root}/sessions`;
        this._retryNoEarlierThan = 0;
    }

    // The 429 deadline, exposed so the notch can remember it across restarts.
    get backoffUntil() {
        return this._retryNoEarlierThan || null;
    }

    set backoffUntil(deadline) {
        this._retryNoEarlierThan = deadline ?? 0;
    }

    available() {
        return exists(this._authPath);
    }

    // The credential carries the signed-in email and name; none of it is the
    // notch's business, and Grok states no plan here.
    account() {
        return {plan: null, source: 'Grok'};
    }

    createSessionMonitor(onChange) {
        return new GrokActivityMonitor(this._activePath, this._sessionsRoot, onChange);
    }

    async fetch() {
        const credential = this._credential();
        // Only `grok` renews this token; an expired one is not a failure here,
        // just a reading made without the network.
        if (credential.expiresAt !== null && credential.expiresAt <= Date.now())
            return this._local(EXPIRED_NOTE);
        if (this._retryNoEarlierThan > Date.now())
            throw new ProviderError('rateLimited', RATE_LIMITED);

        const credits = await this._get(CREDITS_ENDPOINT, credential.token);
        if (credits.status === 401 || credits.status === 403)
            throw new ProviderError('needsAuth', NEEDS_AUTH);
        if (credits.status < 200 || credits.status >= 300)
            throw new ProviderError('badResponse', `Grok answered HTTP ${credits.status}`);
        this._retryNoEarlierThan = 0;

        let windows = windowsFrom(credits.json);
        if (windows.length === 0) {
            // The credits format says nothing about an account billed against a
            // monthly ledger; the unformatted payload is where that one's
            // numbers are.
            const ledger = await this._get(LEDGER_ENDPOINT, credential.token);
            if (ledger.status >= 200 && ledger.status < 300)
                windows = ledgerWindowsFrom(ledger.json);
        }
        if (windows.length === 0)
            return this._local(null);
        return {windows, headlineID: 'credits', fidelity: 'official'};
    }

    // What the notch can say with nothing metered: the turns `grok` ran today.
    // There is no published ceiling to be a fraction of, so the window carries
    // a bare count and the ring stays empty.
    _local(note) {
        const {requestsToday} = readGrokActivity(this._sessionsRoot);
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

    async _get(url, token) {
        const {status, text, headers} = await request('GET', url, {
            'Authorization': `Bearer ${token}`,
            'X-XAI-Token-Auth': 'xai-grok-cli',
            'Accept': 'application/json',
        });
        if (status === 429) {
            const retry = Number(headers.get_one('Retry-After')) || 0;
            this._retryNoEarlierThan = Date.now() + Math.max(60, retry) * 1000;
            throw new ProviderError('rateLimited', RATE_LIMITED);
        }
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
        return {status, json};
    }

    // The file is keyed by `<issuer>::<client id>`. One signed-in CLI is the
    // ordinary case; with several, the one still live wins, otherwise the
    // first trusted entry so its expiry is the thing reported.
    _credential() {
        const entries = [];
        for (const [key, entry] of Object.entries(readJSON(this._authPath) ?? {})) {
            if (entry && typeof entry === 'object' && isTrusted(key, entry))
                entries.push(entry);
        }
        const now = Date.now();
        const live = entries.find(e => {
            const expiresAt = parseDate(e.expires_at);
            return expiresAt === null || expiresAt > now;
        });
        const chosen = live ?? entries[0];
        if (typeof chosen?.key !== 'string' || chosen.key === '')
            throw new ProviderError('needsAuth', NEEDS_AUTH);
        return {token: chosen.key, expiresAt: parseDate(chosen.expires_at)};
    }
}

function isTrusted(key, entry) {
    return key.startsWith(TRUSTED_ISSUER) || entry.oidc_issuer === TRUSTED_ISSUER;
}

function parseDate(text) {
    if (typeof text !== 'string')
        return null;
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : at;
}

function asDate(millis) {
    return millis === null ? null : new Date(millis);
}

// GrokUsage.swift. `creditUsagePercent` is the whole allowance in one number;
// without it the per-product breakdown is the next best thing.
export function windowsFrom(json) {
    const config = json?.config;
    if (!config || typeof config !== 'object')
        return [];
    const resetsAt = asDate(parseDate(config.currentPeriod?.end)
        ?? parseDate(config.billingPeriodEnd));

    const overall = fractionOf(config.creditUsagePercent);
    if (overall !== null) {
        return [{
            id: 'credits',
            label: firstProductName(config) ?? 'Grok Build',
            usedFraction: overall,
            resetsAt,
        }];
    }

    const windows = [];
    for (const product of config.productUsage ?? []) {
        const fraction = fractionOf(product?.usagePercent);
        if (fraction === null)
            continue;
        const name = typeof product.product === 'string' ? humanize(product.product) : 'Usage';
        // The ring is whichever window is called 'credits', so the first one
        // has to carry that id whatever the wire calls the product.
        windows.push({
            id: windows.length === 0 ? 'credits' : product.product ?? name,
            label: name,
            usedFraction: fraction,
            resetsAt,
        });
    }
    return windows;
}

// The unformatted payload: a calendar-month usage ledger rather than an
// allowance. Its `billingPeriodEnd` is when the ledger rolls over, not the day
// the account is charged — nothing in this response states that.
export function ledgerWindowsFrom(json) {
    const config = json?.config;
    const limit = Number(config?.monthlyLimit?.val);
    const used = Number(config?.used?.val);
    if (!(limit > 0) || !Number.isFinite(used) || used < 0)
        return [];
    return [{
        id: 'credits',
        label: 'Monthly limit',
        usedFraction: used / limit,
        resetsAt: asDate(parseDate(config.billingPeriodEnd)),
    }];
}

function firstProductName(config) {
    const name = (config.productUsage ?? [])[0]?.product;
    return typeof name === 'string' ? humanize(name) : null;
}

// "GrokBuild" → "Grok Build". The wire name is one word; the usage modal
// writes two.
function humanize(name) {
    return name.replace(/(?!^)([A-Z])/g, ' $1');
}

function fractionOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value / 100 : null;
}
