function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
}

function mixColor(a, b, t) {
    const x = clamp01(t);
    const r = Math.round(a[0] + (b[0] - a[0]) * x);
    const g = Math.round(a[1] + (b[1] - a[1]) * x);
    const bl = Math.round(a[2] + (b[2] - a[2]) * x);
    return `rgb(${r}, ${g}, ${bl})`;
}

function getUrgencyColor(daysLeft) {
    // 规则：>=100 天保持绿色；100->0 天按 绿->黄->红 渐变。
    const d = Number(daysLeft || 0);
    const green = [156, 255, 172];   // #9cffac
    const yellow = [255, 230, 109];  // #ffe66d
    const red = [255, 104, 104];

    if (d >= 100) return 'rgb(156, 255, 172)';
    if (d <= 0) return 'rgb(255, 104, 104)';

    // u: 0(100天) -> 1(0天)
    const u = (100 - d) / 100;
    if (u <= 0.5) {
        // 100 -> 50: 绿到黄
        return mixColor(green, yellow, u / 0.5);
    }
    // 50 -> 0: 黄到红
    return mixColor(yellow, red, (u - 0.5) / 0.5);
}

function createItemNode(item, isPrimary) {
    const wrap = document.createElement('div');
    wrap.className = isPrimary ? 'card primary' : 'card secondary';

    const daysLeft = Number(item?.daysLeft || 0);
    const eventName = String(item?.name || '目标');

    const daysText = daysLeft === 0 ? '就是今天' : `${daysLeft} 天`;
    const sentenceText = daysLeft === 0
        ? `${eventName} 就是今天`
        : `距离 ${eventName} 还有 ${daysLeft} 天`;

    const name = document.createElement('div');
    name.className = 'name';
    name.innerText = String(item?.name || '未命名');

    const days = document.createElement('div');
    days.className = 'days';
    days.innerText = daysText;
    const urgencyColor = getUrgencyColor(daysLeft);
    days.style.color = urgencyColor;

    const sentence = document.createElement('div');
    sentence.className = 'sentence';
    sentence.innerText = sentenceText;

    wrap.appendChild(name);
    wrap.appendChild(days);
    wrap.appendChild(sentence);
    return wrap;
}

function renderExpanded(layoutRoot, items) {
    layoutRoot.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0) return;

    if (items.length === 1) {
        const only = createItemNode(items[0], true);
        only.classList.add('single');
        layoutRoot.appendChild(only);
        return;
    }

    // 规则：左侧主卡 1 条；右侧最多展示 4 条（总计最多展示 5 条）
    // 这样可避免条目过多时右侧严重挤压导致显示异常。
    const primaryItem = items[0];
    const secondaryItems = items.length >= 5 ? items.slice(1, 5) : items.slice(1);

    const left = document.createElement('div');
    left.className = 'left-pane';
    left.appendChild(createItemNode(primaryItem, true));

    const right = document.createElement('div');
    right.className = 'right-pane';
    right.style.gridTemplateRows = `repeat(${Math.max(1, secondaryItems.length)}, minmax(0, 1fr))`;

    for (const it of secondaryItems) {
        right.appendChild(createItemNode(it, false));
    }

    layoutRoot.appendChild(left);
    layoutRoot.appendChild(right);
}

function renderMinimized(layoutRoot, items) {
    layoutRoot.innerHTML = '';
    const top = Array.isArray(items) && items.length > 0 ? items[0] : null;
    if (!top) return;

    const line = document.createElement('div');
    line.className = 'mini-line';
    const daysLeft = Number(top?.daysLeft || 0);
    const name = String(top?.name || '目标');
    line.innerText = daysLeft === 0 ? `${name} 就是今天` : `距离 ${name} 还有 ${daysLeft} 天`;
    const urgencyColor = getUrgencyColor(daysLeft);
    line.style.color = urgencyColor;
    line.style.borderColor = urgencyColor;
    layoutRoot.appendChild(line);
}

globalThis.CountdownLayout = {
    renderExpanded,
    renderMinimized,
};
