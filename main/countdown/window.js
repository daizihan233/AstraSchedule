const path = require('node:path');

function getExpandedBounds(screen, itemCount = 1) {
    const workArea = screen.getPrimaryDisplay().workArea;
    const count = Math.max(1, Number(itemCount) || 1);
    const width = Math.max(720, Math.floor(workArea.width * 0.62));
    // 条目越多窗口越高，避免右侧卡片被压扁
    const ratio = Math.min(0.56, 0.34 + Math.max(0, count - 1) * 0.045);
    const height = Math.max(320, Math.floor(workArea.height * ratio));
    const x = Math.floor(workArea.x + (workArea.width - width) / 2);
    const y = Math.floor(workArea.y + (workArea.height - height) / 2);
    return {x, y, width, height};
}

function getMinimizedBounds(screen) {
    const workArea = screen.getPrimaryDisplay().workArea;
    const width = 96;
    const height = Math.max(160, Math.floor(workArea.height * 0.42));
    const x = Math.floor(workArea.x + workArea.width - width);
    const y = Math.floor(workArea.y + (workArea.height - height) / 2);
    return {x, y, width, height};
}

function applyModeBounds(win, screen, minimized, itemCount = 1) {
    const bounds = minimized ? getMinimizedBounds(screen) : getExpandedBounds(screen, itemCount);
    win.setBounds(bounds, true);
}

function ensureCountdownWindow(ctx) {
    const {BrowserWindow, screen, state} = ctx;
    if (state.window && !state.window.isDestroyed()) {
        return state.window;
    }

    const win = new BrowserWindow({
        ...getExpandedBounds(screen, (state.latestItems || []).length || 1),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        minimizable: false,
        maximizable: false,
        movable: false,
        hasShadow: false,
        skipTaskbar: true,
        focusable: false,
        fullscreenable: false,
        show: false,
        alwaysOnTop: false,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
        },
    });

    win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
    // 尽量保持底层，不抢焦点
    win.setAlwaysOnTop(false);
    // 注意：这里不要在窗口刚创建时立即开启穿透。
    // Windows 下透明窗在首帧阶段过早开启穿透，可能导致初始看起来不透明。
    win.setIgnoreMouseEvents(false);

    win.on('closed', () => {
        state.window = null;
    });

    const countdownHtml = path.join(__dirname, '..', '..', 'countdown.html');
    // noinspection JSIgnoredPromiseFromCall
    win.loadFile(countdownHtml);

    state.window = win;
    applyModeBounds(win, screen, state.minimized, (state.latestItems || []).length || 1);
    return win;
}

function showCountdownWindow(ctx) {
    const {state, screen} = ctx;
    const win = ensureCountdownWindow(ctx);
    applyModeBounds(win, screen, state.minimized, (state.latestItems || []).length || 1);
    if (!win.isVisible()) {
        if (win.webContents && win.webContents.isLoading()) {
            win.once('ready-to-show', () => {
                if (!win.isDestroyed() && !win.isVisible()) {
                    win.showInactive();
                }
            });
        } else {
            win.showInactive();
        }
    }
    return win;
}

function hideCountdownWindow(state) {
    const win = state.window;
    if (!win || win.isDestroyed()) return;
    win.hide();
}

function setMinimizedMode(ctx, minimized) {
    const {state, screen} = ctx;
    state.minimized = !!minimized;
    const win = ensureCountdownWindow(ctx);
    applyModeBounds(win, screen, state.minimized, (state.latestItems || []).length || 1);
    if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('countdown:mode', {
            minimized: state.minimized,
        });
    }
}

module.exports = {
    ensureCountdownWindow,
    showCountdownWindow,
    hideCountdownWindow,
    setMinimizedMode,
};
