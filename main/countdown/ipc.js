const {hideCountdownWindow, setMinimizedMode, showCountdownWindow} = require('./window');
const {pushCountdownItems} = require('./service');

function registerCountdownIpc(ctx) {
    const {ipcMain, state} = ctx;

    ipcMain.handle('countdown:get-mode', () => ({
        minimized: !!state.minimized,
    }));

    ipcMain.on('countdown:toggle-minimize', () => {
        setMinimizedMode(ctx, !state.minimized);
        if (state.latestItems.length > 0) {
            showCountdownWindow(ctx);
            pushCountdownItems(state);
        }
    });

    ipcMain.on('countdown:hide', () => {
        hideCountdownWindow(state);
    });

    ipcMain.on('countdown:set-ignore-mouse', (_e, payload) => {
        const win = state.window;
        if (!win || win.isDestroyed()) return;
        const ignore = !!payload?.ignore;
        win.setIgnoreMouseEvents(ignore, {forward: true});
    });
}

module.exports = {
    registerCountdownIpc,
};
