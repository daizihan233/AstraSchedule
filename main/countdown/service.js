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

function startOfLocalDay(dt) {
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function dayDiffLocalToday(targetDate) {
    const now = new Date();
    const t0 = startOfLocalDay(now);
    const d0 = startOfLocalDay(targetDate);
    return Math.round((d0 - t0) / 86400000);
}

function formatCountdownText(name, daysLeft) {
    const n = String(name || '目标');
    const d = Number(daysLeft || 0);
    return d === 0 ? `${n}就是今天` : `距离${n}还有${d}天`;
}

function parseClassIdParts(classId) {
    const parts = String(classId || '').split('/').filter(Boolean);
    return {
        school: parts[0] || '',
        grade: parts[1] || '',
        cls: parts[2] || '',
    };
}

function scopeMatch(scope, classId) {
    if (!scope || scope === 'ALL') return true;
    const parts = String(scope).split('/').filter(Boolean);
    const current = parseClassIdParts(classId);
    if (parts.length === 1) return parts[0] === current.school;
    if (parts.length === 2) return parts[0] === current.school && parts[1] === current.grade;
    if (parts.length >= 3) return parts[0] === current.school && parts[1] === current.grade && parts[2] === current.cls;
    return false;
}

function collectEffectiveSchedules(records, classId) {
    const out = [];
    for (const rec of Array.isArray(records) ? records : []) {
        const scopes = Array.isArray(rec.scope) ? rec.scope : [];
        if (scopes.length > 0 && !scopes.some((s) => scopeMatch(s, classId))) {
            continue;
        }
        const schedules = Array.isArray(rec.schedules) ? rec.schedules : [];
        for (const it of schedules) {
            const name = String(it?.name || '').trim();
            const date = String(it?.date || '').trim();
            const priority = Number(it?.priority || 0);
            if (!name || !date) continue;
            const localDate = parseYmdLocal(date);
            if (!localDate) continue;
            const daysLeft = dayDiffLocalToday(localDate);
            // 过期日程自动隐藏（仅展示今天及未来）
            if (daysLeft < 0) continue;
            out.push({name, date, priority, daysLeft});
        }
    }
    out.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.daysLeft - b.daysLeft;
    });
    return out;
}

function requestJsonByNet(net, url) {
    return new Promise((resolve, reject) => {
        const req = net.request({method: 'GET', url});
        let raw = '';
        req.on('response', (res) => {
            res.on('data', (chunk) => {
                raw += chunk.toString();
            });
            res.on('end', () => {
                const code = res.statusCode || 0;
                if (code < 200 || code >= 300) {
                    reject(new Error(`HTTP ${code}`));
                    return;
                }
                try {
                    const parsed = JSON.parse(raw || '{}');
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function fetchCountdownData(ctx) {
    const {net, getServer, getProtocols, getClassId} = ctx;
    const {agreement} = getProtocols();
    const classId = getClassId();
    const url = `${agreement}://${getServer()}/web/countdown?scope=${encodeURIComponent(classId)}`;

    const payload = await requestJsonByNet(net, url);
    if (payload?.loading === true) return {loading: true, items: []};

    const hasConfig = payload?.hasConfig !== undefined ? !!payload.hasConfig : true;
    if (!hasConfig) return {loading: false, items: []};

    const records = Array.isArray(payload?.data) ? payload.data : [];
    const items = collectEffectiveSchedules(records, classId).map((it) => ({
        ...it,
        text: formatCountdownText(it.name, it.daysLeft),
    }));
    return {loading: false, items};
}

function pushCountdownItems(state) {
    const win = state.window;
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;

    const visibleItems = state.minimized ? state.latestItems.slice(0, 1) : state.latestItems;
    win.webContents.send('countdown:update', {
        minimized: state.minimized,
        items: visibleItems,
    });
}

module.exports = {
    fetchCountdownData,
    pushCountdownItems,
};
