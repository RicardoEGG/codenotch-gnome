// The last reading of each provider, remembered across shell restarts and
// preference rebuilds so the notch never opens empty (UsageArchive.swift).
//
// Shape on disk:
//   { "<providerID>": { "snapshot": { windows, headlineID, fetchedAt } | null,
//                       "backoffUntil": <ms since epoch> | null } }
import GLib from 'gi://GLib';

import {readJSON} from './providers/http.js';

const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'codenotch']);
const PATH = GLib.build_filenamev([DIR, 'readings.json']);

function parseDate(text) {
    if (!text)
        return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
}

function restoreSnapshot(raw) {
    if (!raw || !Array.isArray(raw.windows) || typeof raw.fetchedAt !== 'number')
        return null;
    const windows = raw.windows
        .filter(w => w && typeof w.usedFraction === 'number')
        .map(w => ({
            id: w.id,
            label: w.label ?? '',
            usedFraction: w.usedFraction,
            resetsAt: parseDate(w.resetsAt),
        }));
    return {windows, headlineID: raw.headlineID ?? null, fetchedAt: raw.fetchedAt};
}

export function loadArchive() {
    const json = readJSON(PATH);
    const archive = {};
    if (!json || typeof json !== 'object')
        return archive;
    for (const [id, entry] of Object.entries(json)) {
        if (!entry || typeof entry !== 'object')
            continue;
        archive[id] = {
            snapshot: restoreSnapshot(entry.snapshot),
            backoffUntil: typeof entry.backoffUntil === 'number' ? entry.backoffUntil : null,
        };
    }
    return archive;
}

// Dates serialise as ISO strings by themselves; nothing else needs help.
export function saveArchive(archive) {
    try {
        GLib.mkdir_with_parents(DIR, 0o700);
        GLib.file_set_contents(PATH, JSON.stringify(archive, null, 2));
    } catch (e) {
        console.warn(`codenotch: could not save readings: ${e.message}`);
    }
}
