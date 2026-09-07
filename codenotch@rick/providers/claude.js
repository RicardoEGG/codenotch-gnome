// Claude Code keeps its OAuth token in ~/.claude/.credentials.json on Linux
// (on macOS it is in the keychain). Codenotch never signs in anywhere: it
// borrows that token to ask the same usage endpoint Claude Code's /usage does.
import {request, readJSON, home, exists, ProviderError} from './http.js';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

export class ClaudeProvider {
    id = 'claude';
    displayName = 'Claude';
    glyph = 'claude';
    manageURL = 'https://claude.ai/settings/usage';
    tracksSessions = true;

    constructor(configDir = home('.claude')) {
        this._configDir = configDir;
        this._credentialsPath = `${configDir}/.credentials.json`;
    }

    get sessionsDir() {
        return `${this._configDir}/sessions`;
    }

    available() {
        return exists(this._credentialsPath);
    }

    account() {
        const oauth = readJSON(this._credentialsPath)?.claudeAiOauth;
        if (!oauth)
            return null;
        return {plan: oauth.subscriptionType ?? null, source: 'Claude Code'};
    }

    _token() {
        const oauth = readJSON(this._credentialsPath)?.claudeAiOauth;
        if (!oauth?.accessToken)
            throw new ProviderError('needsAuth', 'Sign in to Claude Code to read your usage');
        if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
            throw new ProviderError('expired',
                'Claude Code\'s sign-in has expired — run `claude` once to refresh it');
        }
        return oauth.accessToken;
    }

    async fetch() {
        const token = this._token();
        const {status, text} = await request('GET', ENDPOINT, {
            'Authorization': `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
        });
        if (status === 401 || status === 403)
            throw new ProviderError('needsAuth', 'Sign in to Claude Code to read your usage');
        if (status === 429)
            throw new ProviderError('rateLimited', 'Claude is rate limiting usage reads');
        if (status < 200 || status >= 300)
            throw new ProviderError('badResponse', `Claude answered HTTP ${status}`);

        const json = JSON.parse(text);
        return {
            windows: windowsFrom(json),
            headlineID: 'session',
        };
    }
}

function parseDate(text) {
    if (!text)
        return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

function labelForKind(kind, scope) {
    const model = scope?.model?.display_name;
    if (model)
        return model;
    switch (kind) {
    case 'session': return 'Current session';
    case 'weekly_all': return 'All models';
    case 'weekly_opus': return 'Opus';
    case 'weekly_sonnet': return 'Sonnet';
    default:
        return kind.replace(/^weekly_/, '').replace(/_/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
    }
}

// UsageResponse.limitWindows(): the `limits` array first, then the named
// windows merged in, because a window that has just rolled over disappears
// from `limits` while `five_hour` still carries it.
export function windowsFrom(json) {
    const windows = [];
    for (const limit of json.limits ?? []) {
        const resetsAt = parseDate(limit.resets_at);
        if (!resetsAt || typeof limit.percent !== 'number')
            continue;
        windows.push({
            id: limit.kind,
            label: labelForKind(limit.kind, limit.scope),
            usedFraction: limit.percent / 100,
            resetsAt,
        });
    }
    const merge = (window, id, label) => {
        const resetsAt = parseDate(window?.resets_at);
        if (!window || !resetsAt || windows.some(w => w.id === id))
            return;
        windows.push({id, label, usedFraction: (window.utilization ?? 0) / 100, resetsAt});
    };
    merge(json.five_hour, 'session', 'Current session');
    merge(json.seven_day, 'weekly_all', 'All models');

    const rank = id => id === 'session' ? 0 : id === 'weekly_all' ? 1 : 2;
    windows.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    return windows;
}
