const electron = require('electron');
const { app, BrowserWindow, Menu, ipcMain, dialog, screen, Tray, shell } = electron
const path = require('node:path');
const fs = require('node:fs')
const os = require('node:os')
const createShortcut = require('windows-shortcuts')
const startupFolderPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const prompt = require('electron-prompt');
const Store = require('electron-store');
const { DisableMinimize } = require('electron-disable-minimize');
const store = new Store();



// 添加全局错误处理，防止未捕获的异常导致弹窗
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // 不显示错误弹窗，仅记录错误
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // 不显示错误弹窗，仅记录错误
});
let tray;
let form;
let win;
let template = []
// 统一资源路径解析，兼容 asar
const asset = (...p) => path.join(__dirname, ...p)

// JSONC 简易去注释
function stripJsonComments(str) {
    try {
        // 去掉块注释
        str = str.replaceAll(/\/\*[\s\S]*?\*\//g, '');
        // 去掉行注释（忽略字符串内 // 的复杂情况，这里假设用户配置较为简单）
        str = str.replaceAll(/^\s*\/\/.*$/gm, '');
        return str;
    } catch {
        return str
    }
}

// 仅读取用户配置（JSONC），不写回，避免破坏注释
function getUserConfigPath() {
    try {
        return path.join(app.getPath('userData'), 'scheduleConfig.user.jsonc')
    } catch {
        return null
    }
}

function readUserConfigSafe() {
    try {
        const p = getUserConfigPath();
        if (!p) return null;
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf-8');
        const cleaned = stripJsonComments(raw);
        try {
            return JSON.parse(cleaned)
        } catch {
            return null
        }
    } catch {
        return null
    }
}

function doNothing(_) { /* 一些 dialog 会返回一个 promise 但并不需要处理 */ }

// 使用函数动态获取协议与服务器，避免缓存导致不一致
function getProtocols() {
    const secure = store.get('isSecureConnection', true)
    return { agreement: secure ? 'https' : 'http', agreementWs: secure ? 'wss' : 'ws' }
}
function getServer() {
    return String(store.get('server', 'class.khbit.cn'))
}
let classId = String(store.get("class", "39/2023/1"))
console.log('Class:', classId, 'Server:', getServer(), 'Secure:', store.get("isSecureConnection", true));

const WebSocket = require('ws');
let ws;
let heartbeatTimer = null;
let reconnectTimer = null;

function clearHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
    }
}

let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000; // 最大重连延迟30秒
const INITIAL_RECONNECT_DELAY = 1000; // 初始重连延迟1秒

function scheduleReconnect() {
    // 检查是否禁用了 WebSocket 连接
    if (ws?.disableReconnect) {
        console.log('WebSocket reconnection is disabled, not reconnecting');
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // 指数退避算法，最大延迟30秒
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;

    console.log(`WebSocket will reconnect in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(true, true); // 重置errorFlag为true，从验证证书开始
    }, delay);
}

// 在主进程中直接更新 Tray Tooltip 的辅助函数
let websocketDisabled = false; // 全局标志，表示 WebSocket 是否被禁用
let currentConnectionState = false; // 全局标志，记录当前连接状态

function updateTrayTooltip(connected, forceGreen) {
    // 无论 tray 是否存在，都更新全局状态
    currentConnectionState = connected;
    websocketDisabled = forceGreen || false;

    if (!tray) return;

    const baseTooltip = `星程 - by KuoHu - ${app.getVersion()}`;

    let statusText;
    if (forceGreen) {
        statusText = '在线 (Serverless)';
    } else {
        statusText = connected ? '在线' : '离线';
    }

    let tooltipText = `${baseTooltip} - 状态: ${statusText}`;

    tray.setToolTip(tooltipText);
    console.log('[Main] Tray tooltip updated to:', tooltipText);
}

// 断开 WebSocket 连接并停止重连机制
function disconnectWebSocket() {
    if (ws) {
        // 设置标志，阻止进一步的重连尝试
        ws.disableReconnect = true;

        try {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        } catch (e) {
            console.error('Error closing WebSocket:', e);
        }

        // 清除重连定时器
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // 清除心跳定时器
        clearHeartbeat();

        // 通知渲染进程连接已断开，但保持绿色显示
        if (win && !win.isDestroyed()) {
            win.webContents.send('ws-status', {connected: false, forceGreen: true});
            // 同时更新tray tooltip
            win.webContents.send('update-tray-status', {connected: false, forceGreen: true});
        }

        // 直接在主进程中更新 Tooltip
        updateTrayTooltip(false, true);

        console.log('WebSocket disconnected and reconnection disabled');
    }
}

function connect(rejectUnauthorized = true, resetErrorFlag = false) {
    // 只有在需要重置时才重置errorFlag
    if (resetErrorFlag) {
        reconnectAttempts = 0;
    }

    const { agreementWs } = getProtocols()
    const server = getServer()
    const url = `${agreementWs}://${server}/ws/${classId}`

    try {
        // 关闭旧连接与心跳
        try {
            if (ws) {
                ws.removeAllListeners();
                ws.close();
            }
        } catch {
        }
        clearHeartbeat()
        ws = new WebSocket(url, [], {rejectUnauthorized})
        // 为WebSocket实例添加错误监听器，确保任何错误都不会导致弹窗
        // 重要：必须在WebSocket实例创建后立即添加错误监听器，以捕获所有错误
        ws.on('error', (error) => {
            console.error('WebSocket error:', error)
            clearHeartbeat()
            // 通知渲染进程连接已断开
            if (win && !win.isDestroyed()) {
                win.webContents.send('ws-status', {connected: false});
                // 同时更新tray tooltip
                win.webContents.send('update-tray-status', {connected: false});
            }

            // 直接在主进程中更新 Tooltip
            updateTrayTooltip(false, websocketDisabled);

            if (rejectUnauthorized) {
                // 尝试连接不验证证书
                console.log('Trying to connect without certificate verification...');
                setTimeout(() => {
                    connect(false, false);
                }, 100);
            } else {
                // 已经尝试了不验证证书，现在安排重连
                scheduleReconnect();
            }
        })
    } catch (err) {
        console.error('WebSocket create error:', err)
        // 不显示错误弹窗，仅重连
        scheduleReconnect();
        return
    }


    ws.on('open', () => {
        console.log('Connected to server')
        clearHeartbeat()
        reconnectAttempts = 0; // 连接成功，重置重连计数
        heartbeatTimer = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.ping()
                } catch (e) {
                    console.log('Heartbeat ping failed:', e?.message || e)
                }
                console.log('Heartbeat sent')
            } else {
                console.log('Disconnected from server, No heartbeat sent')
            }
        }, 25000)

        // 重连成功后，主动拉取一次课表，避免丢失推送
        try {
            getScheduleFromCloud()
        } catch (e) {
            console.error('Failed to get schedule after reconnect:', e)
        }
        // 通知渲染进程连接已恢复
        if (win && !win.isDestroyed()) {
            // 检查是否应保持 WebSocket 禁用状态
            const forceGreen = websocketDisabled;
            win.webContents.send('ws-status', {connected: true, forceGreen: forceGreen});
            // 同时更新tray tooltip
            win.webContents.send('update-tray-status', {connected: true, forceGreen: forceGreen});
        }

        // 直接在主进程中更新 Tooltip
        updateTrayTooltip(true, websocketDisabled);
    })
    // 处理接收到的消息
    ws.on('message', (message) => {
        const text = message?.toString?.() ?? ''
        console.log('Received from server:', text)
        if (text === 'SyncConfig') {
            console.log('SyncConfig')
            getScheduleFromCloud()
        }
    })
    // 处理连接关闭
    ws.on('close', (code, reason) => {
        console.log(`WebSocket disconnected (code: ${code}, reason: ${reason})`)
        clearHeartbeat()
        // 通知渲染进程连接已断开
        if (win && !win.isDestroyed()) {
            // 只有在 WebSocket 被禁用的情况下才强制绿色
            win.webContents.send('ws-status', {connected: false, forceGreen: websocketDisabled});
            // 同时更新tray tooltip
            win.webContents.send('update-tray-status', {connected: false, forceGreen: websocketDisabled});
        }

        // 直接在主进程中更新 Tooltip
        updateTrayTooltip(false, websocketDisabled);
        // 无条件进行重连，不区分关闭原因
        scheduleReconnect();

    })
}

// 启动时不立即连接 WebSocket，延迟到第一次获取课表数据后
// connect(); 已移除，改为在 getScheduleFromCloud() 后根据 supportWebSocket 判断

// 防止多开
const gotTheLock = app.requestSingleInstanceLock({ key: 'classSchedule' })
if (!gotTheLock) {
    app.quit();
}
app.on('second-instance', () => {
    if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
    }
})

// 正确禁用缓存的开关名
app.commandLine.appendSwitch('disable-http-cache');

const createWindow = () => {
    // noinspection JSCheckFunctionSignatures
    win = new BrowserWindow({
        x: 0,
        y: 0,
        width: screen.getPrimaryDisplay().workAreaSize.width,
        height: 200,
        frame: false,
        transparent: true,
        alwaysOnTop: store.get('isWindowAlwaysOnTop', true),
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        resizable: false,
        type: 'toolbar',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
    })
    // win.webContents.openDevTools()
    // noinspection JSIgnoredPromiseFromCall
    win.loadFile('index.html')
    if (store.get('isWindowAlwaysOnTop', true))
        win.setAlwaysOnTop(true, 'screen-saver', 9999999999999)
}
function setAutoLaunch() {
    const shortcutName = '星程(请勿重命名).lnk'
    app.setLoginItemSettings({ // backward compatible
        openAtLogin: false,
        openAsHidden: false
    })
    if (store.get('isAutoLaunch', true)) {
        createShortcut.create(startupFolderPath + '/' + shortcutName,
            {
                target: app.getPath('exe'),
                workingDir: app.getPath('exe').split('\\').slice(0, -1).join('\\'),
            }, (e) => { e && console.log(e); })
    } else {
        fs.unlink(startupFolderPath + '/' + shortcutName, () => { })
    }

}

// 简单 semver 校验（x.y.z，可带 -/+ 后缀）
function isSemver(v) {
    return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(v || ''))
}

// 自动更新设置（仅打包且版本为 semver 时生效）
let updaterInitialized = false
function setupAutoUpdater() {
    try {
        if (!store.get('isAutoUpdate', true)) {
            console.log('[Updater] disabled by user setting');
            return;
        }
        if (!app.isPackaged) return;
        const v = app.getVersion();
        if (!isSemver(v)) {
            console.warn('[Updater] disabled due to non-semver version:', v)
            return;
        }
        if (updaterInitialized) return
        const { autoUpdater } = require('electron-updater')
        // 默认镜像地址（latest.yml 与安装包所在目录）- 适配 GitHub 最新发布路径
        const defaultMirror = 'https://hubproxy.khbit.cn/https://github.com/daizihan233/AstraSchedule/releases/latest/download'
        let updateBaseUrl = store.get('updateBaseUrl')
        if (!updateBaseUrl || typeof updateBaseUrl !== 'string' || updateBaseUrl.trim().length === 0) {
            updateBaseUrl = defaultMirror
            store.set('updateBaseUrl', updateBaseUrl)
        }
        autoUpdater.setFeedURL({ provider: 'generic', url: updateBaseUrl.trim() })
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = true
        autoUpdater.allowPrerelease = true
        autoUpdater.on('checking-for-update', () => console.log('[Updater] checking-for-update'))
        autoUpdater.on('update-available', (info) => {
            console.log('[Updater] update-available', info?.version)
            tray?.setToolTip(`星程 - 正在下载更新 ${info?.version || ''}`)
        })
        autoUpdater.on('update-not-available', () => console.log('[Updater] update-not-available'))
        autoUpdater.on('error', (err) => console.error('[Updater] error', err))
        autoUpdater.on('download-progress', (p) => {
            const percent = Math.floor(p.percent || 0)
            tray?.setToolTip(`星程 - 更新下载中 ${percent}%`)
        })
        autoUpdater.on('update-downloaded', () => {
            tray?.setToolTip(`星程 - 更新可用`)
            autoUpdater.quitAndInstall(true, true)
        })
        // 仅启动时检查一次
        const check = () => autoUpdater.checkForUpdates().catch(() => {})
        setTimeout(check, 3000)
        updaterInitialized = true
    } catch (e) {
        console.error('[Updater] setup failed', e)
    }
}

// 存储当前版本号
let currentVersion = 0;
// 标志：是否已经进行过第一次课表数据获取和 WebSocket 初始化
let hasInitializedWebSocket = false;

// 检查网络连接
function checkNetworkConnection() {
    return new Promise((resolve) => {
        const {net} = require('electron')
        const {agreement} = getProtocols()
        const server = getServer()

        // 尝试连接到服务器的根路径（轻量级检查）
        const request = net.request({
            method: 'GET',
            url: `${agreement}://${server}/`,
            timeout: 5000
        })

        let isResolved = false

        request.on('response', (response) => {
            if (!isResolved) {
                isResolved = true
                console.log('[Network] Connection check successful, status:', response.statusCode)
                resolve(true)
            }
        })

        request.on('error', (err) => {
            if (!isResolved) {
                isResolved = true
                console.error('[Network] Connection check failed:', err?.message || err)
                resolve(false)
            }
        })

        request.on('abort', () => {
            if (!isResolved) {
                isResolved = true
                console.warn('[Network] Connection check aborted')
                resolve(false)
            }
        })

        // 5 秒超时后强制返回 false
        setTimeout(() => {
            if (!isResolved) {
                isResolved = true
                console.warn('[Network] Connection check timeout')
                request.abort()
                resolve(false)
            }
        }, 5000)

        request.end()
    })
}

// 重试获取课表数据的辅助函数
async function getScheduleFromCloudWithRetry(maxRetries = 10) {
    for (let i = 0; i < maxRetries; i++) {
        const connected = await checkNetworkConnection()
        if (connected) {
            console.log(`[Network] Attempt ${i + 1}/${maxRetries}: Network connected, fetching schedule...`)
            getScheduleFromCloud()
            return true
        } else {
            console.warn(`[Network] Attempt ${i + 1}/${maxRetries}: Network not available`)
            if (i < maxRetries - 1) {
                console.log(`[Network] Retrying in 2 seconds...`)
                await new Promise(resolve => setTimeout(resolve, 2000))
            }
        }
    }
    console.error('[Network] Failed to establish network connection after', maxRetries, 'attempts')
    // 即使网络连接失败，也继续尝试获取课表（可能在移动网络等不稳定情况下）
    console.log('[Network] Proceeding with schedule fetch despite network check failure')
    getScheduleFromCloud()
    return false
}

function getScheduleFromCloud() {
    const { net } = require('electron')
    const { agreement } = getProtocols()
    // 添加 version 查询参数
    const url = `${agreement}://${getServer()}/${classId}?version=${currentVersion}`
    console.log('Requesting schedule from cloud:', url);

    // noinspection JSCheckFunctionSignatures
    const request = net.request({
        method: 'GET',
        url: url
    })
    let raw = ''
    request.on('response', (response) => {
        const statusCode = response.statusCode;
        console.log('getScheduleFromCloud response status:', statusCode);

        // 处理 304 状态码
        if (statusCode === 304) {
            console.log('Schedule not modified (304), no action taken');
            return;
        }

        if (statusCode < 200 || statusCode >= 300) {
            console.error('getScheduleFromCloud request failed with status:', statusCode);
            // 尝试重连
            if (statusCode !== 304) {
                setTimeout(getScheduleFromCloud, 5000)
            }
            return;
        }

        response.on('data', (chunk) => {
            raw += chunk.toString()
        })
        response.on('end', () => {
            try {
                const scheduleConfigSync = JSON.parse(raw)
                console.log('Received schedule config from cloud:', scheduleConfigSync)

                // 检查返回的 JSON 中是否含有 version 键
                if (scheduleConfigSync.version !== undefined) {
                    const newVersion = Number.parseInt(scheduleConfigSync.version);
                    if (!Number.isNaN(newVersion) && newVersion > currentVersion) {
                        currentVersion = newVersion;
                        console.log('Updated version to:', currentVersion);
                    }
                }

                // 检查是否含有 supportWebSocket 键
                const supportWebSocket = scheduleConfigSync["supportWebSocket"] !== undefined ?
                    Boolean(scheduleConfigSync["supportWebSocket"]) : true;

                console.log(`[WebSocket] supportWebSocket=${supportWebSocket}, hasInitialized=${hasInitializedWebSocket}`);

                // 根据 supportWebSocket 值决定是否连接 WebSocket
                websocketDisabled = !supportWebSocket; // 更新全局状态

                if (!supportWebSocket) {
                    // 如果不支持 WebSocket，则断开现有连接并停止重连机制
                    console.log('[WebSocket] Server does not support WebSocket, disconnecting...');
                    disconnectWebSocket();
                    // 无论如何都要更新 Tooltip 状态，确保 Serverless 提示正确显示
                    updateTrayTooltip(false, true);
                } else if (!hasInitializedWebSocket || !ws || ws.readyState !== WebSocket.OPEN) {
                    console.log('[WebSocket] Server supports WebSocket, connecting...');
                    if (!hasInitializedWebSocket) {
                        hasInitializedWebSocket = true;
                    }
                    connect();
                }

                if (win && !win.isDestroyed()) win.webContents.send('newConfig', scheduleConfigSync)
            } catch (err) {
                console.error('getScheduleFromCloud JSON parse error:', err)
                // 不显示错误弹窗，仅记录错误
            }
            console.log('No more data in response.')
        })
    })
    request.on('error', (err) => {
        console.error('getScheduleFromCloud request error:', err)
        // 不显示错误弹窗，仅记录错误
        // 稍后重试
        setTimeout(getScheduleFromCloud, 5000)
    })
    request.end()
}
app.whenReady().then(() => {
    createWindow()
    Menu.setApplicationMenu(null)
    setupAutoUpdater()
    // 先进行网络连接检查，然后获取课表数据
    getScheduleFromCloudWithRetry();
    win.webContents.on('did-finish-load', () => {
        win.webContents.send('getWeekIndex');

    })
    // powerMonitor 事件无 preventDefault
    electron.powerMonitor.on('suspend', () => {
        app.quit()
    })
    electron.powerMonitor.on('shutdown', () => {
        app.quit()
    })
    const handle = win.getNativeWindowHandle();
    try { DisableMinimize(handle) } catch (e) { console.warn('DisableMinimize failed:', e?.message || e) }
    setAutoLaunch()
})



// 仅提供读取用户配置的 IPC
ipcMain.handle('readUserConfig', () => readUserConfigSafe())
ipcMain.handle('getUserConfigPath', () => getUserConfigPath())

ipcMain.on('getWeekIndex', (e, arg) => {
    // 销毁旧的 Tray 实例，避免重复创建和状态丢失
    if (tray) {
        try {
            tray.destroy();
        } catch (err) {
            console.error('Failed to destroy tray:', err);
        }
    }
    tray = new Tray(asset('image', 'icon.png'))
    template = [
        {
            label: '连接云端',
            type: 'checkbox',
            checked: store.get('isFromCloud', false),
            click: (e) => {
                store.set('isFromCloud', e.checked)
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '更新源(可选)',
            click: () => {
                const current = store.get('updateBaseUrl', '') || ''
                prompt({
                    title: '更新源(可选)',
                    label: '请输入更新源基础地址(需包含 latest.yml 的目录，如 https://your.cdn.com/app)：',
                    value: current,
                    inputAttrs: { type: 'string' },
                    type: 'input',
                    height: 220,
                    width: 520,
                    icon: asset('image', 'toggle.png'),
                }).then((r) => {
                    if (r === null) {
                        console.log('[Updater] Mirror cancelled')
                    } else {
                        store.set('updateBaseUrl', r.toString())
                        dialog.showMessageBox(win, {message: '更新源已保存，重启应用后生效。'}).then(doNothing)
                    }
                })
            }
        },
        {
            label: '检查更新',
            click: () => {
                if (!app.isPackaged) {
                    dialog.showMessageBox(win, { message: '开发模式下不检查更新。' }).then(doNothing)
                    return
                }
                if (!isSemver(app.getVersion())) {
                    dialog.showMessageBox(win, { message: '当前版本号非语义化版本，已禁用自动更新。' }).then(doNothing)
                    return
                }
                setupAutoUpdater()
                // 按需加载再调用
                const { autoUpdater } = require('electron-updater')
                autoUpdater.checkForUpdates().catch((err) => {
                    console.error('[Updater] manual check failed', err)
                    dialog.showMessageBox(win, { type: 'error', message: '检查更新失败，请稍后再试。' }).then(doNothing)
                })
            }
        },
        {
            label: '自动更新',
            type: 'checkbox',
            checked: store.get('isAutoUpdate', true),
            click: (e) => {
                store.set('isAutoUpdate', e.checked)
                if (e.checked) {
                    setupAutoUpdater()
                } else {
                    console.log('[Updater] auto-update disabled by user');
                }
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '云端服务',
            click: () => {
                win.webContents.send('fromCloud')
            }
        },
        {
            label: '安全连接',
            type: 'checkbox',
            checked: store.get('isSecureConnection', true),
            click: (e) => {
                store.set('isSecureConnection', e.checked)
                win.webContents.send('setCloudSec', e.checked)
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '所在班级',
            click: () => {
                win.webContents.send('setClass')
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '刷新天气',
            click: () => {
                win.webContents.send('updateWeather')
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '当前地区',
            click: () => {
                prompt({
                    title: '地理位置',
                    label: '请设置当前所在地区:',
                    value: store.get('local', ""),
                    inputAttrs: {
                        type: 'string'
                    },
                    type: 'input',
                    height: 180,
                    width: 400,
                    icon: asset('image', 'toggle.png'),
                }).then((r) => {
                    if (r === null) {
                        console.log('[Local] User cancelled');
                    } else {
                        store.set('local', r.toString())
                        console.log('[Local] ', r.toString());
                    }
                })
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '更新课表',
            click: () => {
                // Serverless 模式下直接拉取课表，无需广播
                if (websocketDisabled) {
                    getScheduleFromCloud();
                    return;
                }
                win.webContents.send('broadcastSyncConfig')
            }
        },
        {
            type: 'separator'
        },
        {
            icon: asset('image', 'setting.png'),
            label: '配置课表',
            click: () => {
                win.webContents.send('openSettingDialog')
            }
        },
        {
            icon: asset('image', 'clock.png'),
            label: '矫正计时',
            click: () => {
                win.webContents.send('getTimeOffset')
            }
        },
        {
            icon: asset('image', 'toggle.png'),
            label: '切换日程',
            click: () => {
                win.webContents.send('setDayOffset')
            }
        },
        {
            icon: asset('image', 'github.png'),
            label: '源码仓库',
            click: () => {
                shell.openExternal('https://github.com/daizihan233/AstraSchedule').then(doNothing);
            }
        },
        {
            type: 'separator'
        },
        {
            id: 'countdown',
            label: '课上计时',
            type: 'checkbox',
            checked: store.get('isDuringClassCountdown', true),
            click: (e) => {
                store.set('isDuringClassCountdown', e.checked)
                win.webContents.send('ClassCountdown', e.checked)
            }
        },
        {
            label: '窗口置顶',
            type: 'checkbox',
            checked: store.get('isWindowAlwaysOnTop', true),
            click: (e) => {
                store.set('isWindowAlwaysOnTop', e.checked)
                if (store.get('isWindowAlwaysOnTop', true))
                    win.setAlwaysOnTop(true, 'screen-saver', 9999999999999)
                else
                    win.setAlwaysOnTop(false)
            }
        },
        {
            label: '始终缩小',
            type: 'checkbox',
            checked: store.get('isAlwaysMinimized', false),
            click: (e) => {
                store.set('isAlwaysMinimized', e.checked)
                win.webContents.send('AlwaysMinimized', e.checked)
            }
        },
        {
            label: '上课隐藏',
            type: 'checkbox',
            checked: store.get('isDuringClassHidden', true),
            click: (e) => {
                store.set('isDuringClassHidden', e.checked)
                win.webContents.send('ClassHidden', e.checked)
            }
        },
        {
            label: '开机启动',
            type: 'checkbox',
            checked: store.get('isAutoLaunch', true),
            click: (e) => {
                store.set('isAutoLaunch', e.checked)
                setAutoLaunch()
            }
        },
        {
            type: 'separator'
        },
        {
            icon: asset('image', 'quit.png'),
            label: '退出程序',
            click: () => {
                dialog.showMessageBox(win, {
                    title: '请确认',
                    message: '你确定要退出程序吗?',
                    buttons: ['取消', '确定']
                }).then((data) => {
                    if (data.response) app.quit()
                })
            }
        }
    ]
    template[arg]?.checked !== undefined && (template[arg].checked = true)
    form = Menu.buildFromTemplate(template)
    // 恢复之前的 ToolTip 状态
    updateTrayTooltip(currentConnectionState, websocketDisabled)
    function trayClicked() {
        tray.popUpContextMenu(form)
    }
    tray.on('click', trayClicked)
    tray.on('right-click', trayClicked)
    tray.setContextMenu(form)
    win.webContents.send('ClassCountdown', store.get('isDuringClassCountdown', true))
    win.webContents.send('ClassHidden', store.get('isDuringClassHidden', true))
    win.webContents.send('AlwaysMinimized', store.get('isAlwaysMinimized', false))
})

// 提供鼠标位置与窗口边界给渲染进程（用于穿透下的悬停检测）
ipcMain.handle('getCursorAndBounds', () => {
    try {
        const pt = screen.getCursorScreenPoint()
        const bounds = win?.getBounds?.() || { x: 0, y: 0, width: 0, height: 0 }
        return { cursor: pt, bounds }
    } catch (e) {
        console.error('getCursorAndBounds error:', e)
        return { cursor: { x: 0, y: 0 }, bounds: { x: 0, y: 0, width: 0, height: 0 } }
    }
})

ipcMain.on('log', (e, arg) => {
    console.log(arg);
})

ipcMain.on('setIgnore', (e, arg) => {
    if (arg)
        win.setIgnoreMouseEvents(true, { forward: true });
    else
        win.setIgnoreMouseEvents(false);
})

ipcMain.on('dialog', (e, arg) => {
    dialog.showMessageBox(win, arg.options).then((data) => {
        e.reply(arg.reply, { 'arg': arg, 'index': data.response })
    })
})

ipcMain.on('pop', () => {
    tray.popUpContextMenu(form)
})

const MAX_WEATHER_RETRIES = 5
const WEATHER_RETRY_DELAY_MS = 5000
let weatherRequestInFlight = false
let weatherRetryTimer = null
let weatherRetryCount = 0

function clearWeatherRetryTimer() {
    if (weatherRetryTimer) {
        clearTimeout(weatherRetryTimer)
        weatherRetryTimer = null
    }
}

function finishWeatherCycle() {
    weatherRequestInFlight = false
    clearWeatherRetryTimer()
    weatherRetryCount = 0
}

function scheduleWeatherRetry() {
    weatherRequestInFlight = false
    weatherRetryCount += 1
    if (weatherRetryCount >= MAX_WEATHER_RETRIES) {
        // 达到最大重试次数后静默停止，不提示、不改变 UI
        finishWeatherCycle()
        return
    }
    clearWeatherRetryTimer()
    weatherRetryTimer = setTimeout(() => {
        weatherRetryTimer = null
        requestWeatherWithRetry()
    }, WEATHER_RETRY_DELAY_MS)
}

function requestWeatherWithRetry() {
    if (weatherRequestInFlight) return
    weatherRequestInFlight = true

    const { net } = require('electron')
    const { agreement } = getProtocols()
    const request = net.request(
        `${agreement}://${getServer()}/api/weather/${store.get('local', "")}`
    )
    let raw = ''
    request.on('response', (response) => {
        const status = response.statusCode || 0
        response.on('data', (chunk) => {
            raw += chunk.toString()
        })
        response.on('end', () => {
            if (status >= 200 && status < 300) {
                try {
                    const weatherData = JSON.parse(raw)
                    if (win && !win.isDestroyed()) win.webContents.send('setWeather', weatherData)
                    finishWeatherCycle()
                } catch {
                    // 解析失败按失败重试，静默处理
                    scheduleWeatherRetry()
                }
            } else {
                // 非 2xx 仅重试，不提示、不改变 UI
                scheduleWeatherRetry()
            }
        })
    })
    request.on('error', () => {
        // 网络错误仅重试，不提示、不改变 UI
        scheduleWeatherRetry()
    })
    request.end()
}

ipcMain.on('getWeather', () => {
    // 仅由触发方决定何时拉取；这里统一执行“最多 5 次”的静默重试策略
    if (weatherRequestInFlight || weatherRetryTimer) return
    weatherRetryCount = 0
    requestWeatherWithRetry()
})

ipcMain.on('RequestSyncConfig', () => {
    prompt({
        title: '云端密码',
        label: '请输入密码：',
        value: "",
        inputAttrs: { type: 'password' },
        type: 'input',
        height: 180,
        width: 400,
        icon: asset('image', 'toggle.png'),
    }).then((r) => {
        if (r === null) return;
        const { net } = require('electron')
        const { agreement } = getProtocols()
        // noinspection JSCheckFunctionSignatures
        const request = net.request({
            method: 'POST',
            url: `${agreement}://${getServer()}/api/broadcast/${classId}`,
            headers: {
                "Authorization": 'Basic ' + Buffer.from('ElectronClassSchedule:' + String(r)).toString('base64'),
            }
        })
        try {
            request.on('response', (response) => {
                response.on('data', () => {})
                response.on('end', () => {
                    const { dialog } = require('electron');
                    if (response.statusCode === 200) {
                        dialog.showMessageBox(
                            { type: 'info', title: '提示', message: '已下发成功', buttons: ['已阅'] }).then(doNothing)
                    } else if (response.statusCode === 401) {
                        dialog.showMessageBox({ type: 'error', title: '错误', message: '服务端返回 401，可能密码错误', buttons: ['已阅'] }).then(doNothing)
                    } else {
                        dialog.showMessageBox({ type: 'error', title: '错误', message: `服务端返回 ${response.statusCode}` , buttons: ['已阅'] }).then(doNothing)
                    }
                })
            })
        } catch (e) {
            console.log(e)
        }
        request.on('error', (err) => console.error('Broadcast request error:', err))
        request.end()
    })
})

// 处理来自渲染进程的tray状态更新请求

ipcMain.on('update-tray-status', (e, arg) => {
    if (tray) {
        const baseTooltip = `星程 - by KuoHu - ${app.getVersion()}`
        // 检查是否强制保持绿色显示（WebSocket 被禁用）
        const forceGreen = arg.forceGreen || false;

        // 更新全局 websocketDisabled 状态
        websocketDisabled = forceGreen;

        let statusText;
        if (forceGreen) {
            statusText = '在线 (轻量Serverless模式)';
        } else {
            statusText = arg.connected ? '在线' : '离线(弱网)'
        }

        // 如果 WebSocket 被禁用，添加额外的提示
        let tooltipText = `${baseTooltip} - 状态: ${statusText}`;
        if (forceGreen) {
            tooltipText += '\n服务端正处于轻量 Serverless 模式，数据更新可能延迟';
        }

        tray.setToolTip(tooltipText);
        console.log('[Main] Tray tooltip updated to:', tooltipText);
    }
})



ipcMain.on('getTimeOffset', (e, arg) => {
    prompt({
        title: '计时矫正',
        label: '请设置课表计时与系统时间的偏移秒数:',
        value: String(arg ?? 0),
        inputAttrs: {
            type: 'number'
        },
        type: 'input',
        height: 180,
        width: 400,
        icon: asset('image', 'clock.png'),
    }).then((r) => {
        if (r === null) {
            console.log('[getTimeOffset] User cancelled');
        } else {
            win.webContents.send('setTimeOffset', Number(r) % 10000000000000)
        }
    })
})

ipcMain.on('fromCloud', (e, arg) => {
    prompt({
        title: '云端服务',
        label: '请设置云端服务：',
        value: String(arg ?? store.get('server', 'class.khbit.cn')),
        inputAttrs: {
            type: 'string'
        },
        type: 'input',
        height: 180,
        width: 400,
        icon: asset('image', 'toggle.png'),
    }).then((r) => {
        if (r === null) {
            console.log('[Cloud] User cancelled');
        } else {
            win.webContents.send('setCloudUrl', r.toString())
            store.set('server', r.toString())
            console.log('[Cloud] ', r.toString());
        }
    })
})

// 新增：处理“所在班级”提示框与保存
ipcMain.on('setClass', (e, arg) => {
    prompt({
        title: '所在班级',
        label: '请输入班级标识(例如 39/2023/1)：',
        value: String(arg ?? store.get('class', '39/2023/1')),
        inputAttrs: {type: 'string'},
        type: 'input',
        height: 180,
        width: 400,
        icon: asset('image', 'toggle.png'),
    }).then((r) => {
        if (r === null) {
            console.log('[Class] User cancelled');
            return;
        }
        const val = r.toString();
        try {
            store.set('class', val)
        } catch {
        }
        try {
            win?.webContents?.send('setCloudClass', val)
        } catch {
        }
        // 同步内存中的 classId，随后重连以生效
        classId = val
        console.log('[Class] set to', val)
        try {
            ws?.close?.()
        } catch {
        }
        try {
            connect()
        } catch {
        }
    })
})

// 添加 IPC 事件处理器，用于处理来自渲染进程的 getScheduleFromCloud 请求
ipcMain.on('getScheduleFromCloud', (e, arg) => {
    // 直接调用 getScheduleFromCloud 函数
    getScheduleFromCloud();
});
