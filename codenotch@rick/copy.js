import GLib from 'gi://GLib';

// ResetCopy.swift: relative under an hour, absolute beyond that, and only a
// day-and-month a week or more out, so a monthly reset never reads as "this
// Monday".
export function resetText(resetsAt, now = new Date()) {
    const seconds = (resetsAt.getTime() - now.getTime()) / 1000;
    if (seconds <= 0)
        return 'Resetting…';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `Resets in ${Math.max(1, minutes)} min`;

    const dt = GLib.DateTime.new_from_unix_local(Math.floor(resetsAt.getTime() / 1000));
    if (daysApart(now, resetsAt) >= 7)
        return `Resets ${dt.format('%b %-d')}`;
    return `Resets ${dt.format('%a %-l:%M %p')}`;
}

function daysApart(a, b) {
    const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((db - da) / 86400000);
}

// ElapsedCopy.swift
export function elapsedText(since, now = new Date()) {
    const seconds = Math.max(0, (now.getTime() - since.getTime()) / 1000);
    if (seconds < 45)
        return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${Math.max(1, minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

export function percentText(fraction) {
    return `${Math.round(fraction * 100)}%`;
}

// A window with no published ceiling: the count itself, with a tilde when the
// notch counted it off local files rather than being told it.
export function countText(used, approximate) {
    return `${approximate ? '~' : ''}${used} ${used === 1 ? 'request' : 'requests'} today`;
}
