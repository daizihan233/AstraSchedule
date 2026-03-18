function parseYmdLocal(ymd) {
    if (typeof ymd !== 'string') return null;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(ymd.trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || !mo || !d) return null;
    return new Date(y, mo - 1, d);
}

function toLocalDayStart(dt) {
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function dayDiffLocal(today, target) {
    const t0 = toLocalDayStart(today);
    const d0 = toLocalDayStart(target);
    return Math.round((d0 - t0) / 86400000);
}

globalThis.CountdownTime = {
    parseYmdLocal,
    dayDiffLocal,
};
