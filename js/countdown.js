const {ipcRenderer} = require('electron');

const root = document.getElementById('countdownRoot');
const toggleBtn = document.getElementById('toggleMode');
const emptyState = document.getElementById('emptyState');
const mainLayout = document.getElementById('mainLayout');

let minimized = false;
let defaultIgnoreArmed = false;

function setMode(nextMin) {
    minimized = !!nextMin;
    root.classList.toggle('minimized', minimized);
    root.classList.toggle('expanded', !minimized);
    toggleBtn.innerText = minimized ? '⇖' : '⇔';
}

function render(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const isMin = !!payload?.minimized;
    setMode(isMin);
    armDefaultIgnoreAfterFirstPaint();

    if (items.length === 0) {
        emptyState.style.display = 'block';
        mainLayout.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    mainLayout.style.display = 'grid';

    if (isMin) {
        globalThis.CountdownLayout.renderMinimized(mainLayout, items);
    } else {
        globalThis.CountdownLayout.renderExpanded(mainLayout, items);
    }
}

ipcRenderer.on('countdown:update', (_e, payload) => {
    render(payload || {});
});

ipcRenderer.on('countdown:mode', (_e, payload) => {
    const nextMin = !!payload?.minimized;
    setMode(nextMin);
});

toggleBtn.addEventListener('click', () => {
    ipcRenderer.send('countdown:toggle-minimize');
});

// 默认穿透；当鼠标停在按钮上时临时关闭穿透以便点击
function setIgnoreMouse(ignore) {
    ipcRenderer.send('countdown:set-ignore-mouse', {ignore: !!ignore});
}

function armDefaultIgnoreAfterFirstPaint() {
    if (defaultIgnoreArmed) return;
    defaultIgnoreArmed = true;
    requestAnimationFrame(() => {
        setTimeout(() => {
            setIgnoreMouse(true);
        }, 120);
    });
}

toggleBtn.addEventListener('mouseenter', () => {
    setIgnoreMouse(false);
});

toggleBtn.addEventListener('mouseleave', () => {
    setIgnoreMouse(true);
});

async function boot() {
    try {
        const mode = await ipcRenderer.invoke('countdown:get-mode');
        setMode(!!mode?.minimized);
    } catch {
        setMode(false);
    }
    // 首帧先保持可交互，避免透明窗初始化阶段出现不透明渲染。
    setIgnoreMouse(false);
    armDefaultIgnoreAfterFirstPaint();
}

boot();
