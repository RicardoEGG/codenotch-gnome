// Codex CLI writes its ChatGPT session to ~/.codex/auth.json. The usage
// endpoint is the one the Codex app itself reads; the token is never
// refreshed or written by us.
import GLib from 'gi://GLib';
import {request, readJSON, home, exists, ProviderError} from './http.js';

const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';

export class CodexProvider {
    id = 'codex';
    displayName = 'Codex';
    glyph = 'openai';
    manageURL = 'https://chatgpt.com/#settings/Account';
    tracksSessions = false;

    constructor(authPath = home('.codex', 'auth.json')) {
        this._authPath = authPath;
        this._retryNoEarlierThan = 0;
    }

    available() {
        return exists(this._authPath);
    }

    account() {
        const claims = jwtClaims(readJSON(this._authPath)?.tokens?.access_token);
        const auth = claims?.['https://api.openai.com/auth'];
        return {plan: auth?.chatgpt_plan_type ?? null, source: 'Codex'};
    }

    _credential() {
        const tokens = readJSON(this._authPath)?.tokens;
        const accessToken = tokens?.access_token?.trim();
        const accountID = tokens?.account_id?.trim();
        if (!accessToken || !accountID)
            throw new ProviderError('needsAuth', 'Sign in to Codex to read your usage');
        const exp = jwtClaims(accessToken)?.exp;
        if (typeof exp === 'number' && exp * 1000 < Date.now())
            throw new ProviderError('expired', 'Codex\'s sign-in has expired — open Codex once to refresh it');
        return {accessToken, accountID};
    }

    async fetch() {
        const now = Date.now();
        if (this._retryNoEarlierThan > now)
            throw new ProviderError('rateLimited', 'Codex asked us to wait before reading again');
        const {accessToken, accountID} = this._credential();
        const {status, text, headers} = await request('GET', ENDPOINT, {
            'Authorization': `Bearer ${accessToken}`,
            'ChatGPT-Account-Id': accountID,
            'Accept': 'application/json',
            'Cache-Control': 'no-cache, no-store',
        });
        if (status === 401 || status === 403)
            throw new ProviderError('needsAuth', 'Sign in to Codex to read your usage');
        if (status === 429) {
            const retry = Number(headers.get_one('Retry-After')) || 0;
            this._retryNoEarlierThan = Date.now() + Math.max(60, retry) * 1000;
            throw new ProviderError('rateLimited', 'Codex asked us to wait before reading again');
        }
        if (status < 200 || status >= 300)
            throw new ProviderError('badResponse', `Codex answered HTTP ${status}`);
        this._retryNoEarlierThan = 0;

        const windows = windowsFrom(JSON.parse(text));
        return {windows, headlineID: windows[0]?.id ?? null};
    }
}

function jwtClaims(token) {
    try {
        const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = GLib.base64_decode(payload + '='.repeat((4 - payload.length % 4) % 4));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function label(windowSeconds, fallback) {
    if (!(windowSeconds > 0))
        return fallback === 'primary' ? 'Current session' : 'Longer window';
    const minutes = windowSeconds / 60;
    if (minutes < 60)
        return `${Math.floor(minutes)}m limit`;
    if (minutes < 60 * 24)
        return `${Math.floor(minutes / 60)}h limit`;
    const days = Math.round(minutes / (60 * 24));
    if (days === 7)
        return 'Weekly limit';
    if (days === 30)
        return 'Monthly limit';
    return `${days}d limit`;
}

export function windowsFrom(json, now = Date.now()) {
    const windows = [];
    const rateLimit = json.rate_limit ?? {};
    for (const [id, window] of [['primary', rateLimit.primary_window],
        ['secondary', rateLimit.secondary_window]]) {
        if (!window)
            continue;
        if (typeof window.used_percent !== 'number')
            throw new ProviderError('badResponse', 'Codex reported a window without a percentage');
        let resetsAt = null;
        if (typeof window.reset_at === 'number')
            resetsAt = new Date(window.reset_at * 1000);
        else if (typeof window.reset_after_seconds === 'number')
            resetsAt = new Date(now + window.reset_after_seconds * 1000);
        windows.push({
            id,
            label: label(window.limit_window_seconds, id),
            usedFraction: window.used_percent / 100,
            resetsAt,
        });
    }
    if (windows.length === 0)
        throw new ProviderError('badResponse', 'Codex reported no usage windows');
    return windows;
}
