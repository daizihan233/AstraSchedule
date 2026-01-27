const { ipcRenderer } = require('electron');

// 新增：深合并与用户配置加载/保存
function isPlainObject(x) {
    return x && typeof x === 'object' && !Array.isArray(x);
}

function deepMerge(base, override) {
    if (!isPlainObject(base)) return structuredClone(override);
    const out = {...base};
    for (const k of Object.keys(override || {})) {
        const bv = base?.[k];
        const ov = override[k];
        if (isPlainObject(bv) && isPlainObject(ov)) out[k] = deepMerge(bv, ov)
        else out[k] = Array.isArray(ov) ? ov.slice() : ov;
    }
    return out;
}

async function loadAndMergeUserConfig() {
    try {
        const user = await ipcRenderer.invoke('readUserConfig');
        if (user && typeof user === 'object') {
            scheduleConfig = deepMerge(structuredClone(_scheduleConfig), user)
        } else {
            scheduleConfig = structuredClone(_scheduleConfig)
        }
        // 不写回：避免破坏用户配置中的注释
    } catch {
        scheduleConfig = structuredClone(_scheduleConfig)
    }
}

let scheduleData = getScheduleData();
// DOM 元素引用延后初始化
let classContainer;
let countdownContainer;
let cacheCountdownContainerOffsetWidth = 0;
let corunit;
let currentFullName;
let countdownText;
let weekEN;
let weekCH;
let countdownDays;
let miniCountdown;
let rightSidebar;
let leftSidebar;
let temperature;
let weather;
let bannerText;
let banner;
// 天气预警字符串
let weatherWarn = ''
// 天气预警更新时间戳（ms）
let weatherWarnTs = 0
// 最近一次天气原始数据（用于在配置切换简略/详细时立即重算）
let lastWeatherPayload = null
// 默认横幅高度（用于从 0 恢复）
let defaultBannerHeight = null
let root = null;
let isClassCountdown = true
let isClassHidden = true
let isAlwaysMinimized = false // 始终缩小状态
let isSecureConnection = true // 渲染态标记
let lastScheduleData = {
    currentHighlight: {
        index: null,
        type: null,
        fullName: null,
        countdown: null,
        countdownText: null
    },
    scheduleArray: [null, null, null],
    timetable: null,
    divider: [null, null]
}

// 解析 YYYY-MM-DD（或 YYYY-M-D）为本地时区日期（00:00），避免被当作 UTC 解析
function parseCountdownTargetLocal(ymd) {
    if (typeof ymd !== 'string') return null;
    const s = ymd.trim();
    const m = new RegExp(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/).exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || !mo || !d) return null;
    // 使用本地 Date 构造，时间为本地 00:00
    return new Date(y, mo - 1, d);
}

// 获取本地当天零点
function startOfLocalDay(dt) {
    if (!(dt instanceof Date)) return null;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

// 本地“天”为单位的日期差（b - a），对齐零点并对 DST 采用四舍五入以保证为整数天
function dayDiffLocal(a, b) {
    const a0 = startOfLocalDay(a);
    const b0 = startOfLocalDay(b);
    if (!a0 || !b0) return Number.NaN;
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((b0 - a0) / msPerDay);
}

// 跑马灯 polyfill（延后初始化）：为 #bannerText 提供 start()/stop() 与滚动效果
function initBannerMarquee() {
    const el = bannerText;
    if (!el) return;

    // 如果已初始化过，避免重复绑定
    if (el._marqueeInited) return;
    el._marqueeInited = true;

    // 内部状态
    let rafId = null;
    let lastTs = 0;
    let offsetX = 0; // 当前偏移（px）
    let textWidth = 0; // 单段文本宽度（含间隔）
    let needScroll = false;
    let lastText = '';
    const speed = 80; // px/秒
    let observer; // 提升 observer，便于构建期间断开监听

    function cleanupTrack() {
        if (el._track && el.contains(el._track)) {
            el._track.remove()
        }
        el._track = null;
    }

    function buildStructure(text) {
        if (observer) observer.disconnect();
        el._updating = true;
        el.textContent = text || '';
        if (!text) {
            cleanupTrack();
            el._updating = false;
            if (observer) observer.observe(el, { characterData: true, childList: true, subtree: true });
            return;
        }
        const track = document.createElement('div');
        track.className = 'marquee-track';
        const seg1 = document.createElement('span');
        seg1.className = 'marquee-seg';
        seg1.textContent = text;
        const gap = document.createElement('span');
        gap.className = 'marquee-gap';
        const gapText = '\u00A0\u00A0\u00A0\u00A0';
        gap.textContent = gapText;
        const seg2 = document.createElement('span');
        seg2.className = 'marquee-seg';
        seg2.textContent = text;
        track.appendChild(seg1);
        track.appendChild(gap);
        track.appendChild(seg2);

        el.innerHTML = '';
        el.appendChild(track);
        el._track = track;

        const measurer = document.createElement('span');
        measurer.style.visibility = 'hidden';
        measurer.style.position = 'absolute';
        measurer.style.whiteSpace = 'nowrap';
        measurer.textContent = text + gapText;
        el.appendChild(measurer);
        const containerW = el.clientWidth;
        const measured = measurer.getBoundingClientRect().width;
        measurer.remove();
        textWidth = Math.ceil(measured);
        needScroll = textWidth > containerW;

        if (needScroll) {
            if (!el._track) el.appendChild(track);
            el.classList.remove('centered');
        } else {
            track.style.transform = 'translateX(0)';
            el.textContent = text;
            cleanupTrack();
            el.classList.add('centered');
        }

        offsetX = 0;
        lastText = text;
        el._updating = false;
        if (observer) observer.observe(el, { characterData: true, childList: true, subtree: true });
    }

    function loop(ts) {
        if (!el._track) { rafId = null; return; }
        if (!lastTs) lastTs = ts;
        const dt = (ts - lastTs) / 1000;
        lastTs = ts;
        offsetX -= speed * dt;
        while (offsetX <= -textWidth) {
            offsetX += textWidth; // 右侧无缝再入
        }
        el._track.style.transform = `translateX(${offsetX}px)`;
        rafId = globalThis.requestAnimationFrame(loop);
    }

    function start() {
        if (!el) return;
        const currentText = (el._track ? (el._track.querySelector('.marquee-seg')?.textContent || '') : (el.textContent || ''));
        buildStructure(currentText);
        if (!needScroll || !el._track) return;
        if (rafId) return;
        el.classList.remove('paused');
        lastTs = 0;
        rafId = globalThis.requestAnimationFrame(loop);
    }

    function stop() {
        if (rafId) {
            globalThis.cancelAnimationFrame(rafId);
            rafId = null;
        }
        el.classList.add('paused');
    }

    el.start = start;
    el.stop = stop;

    observer = new MutationObserver(() => {
        if (el._updating) return;
        const hasTrack = el._track && el.contains(el._track);
        const text = hasTrack ? (el._track.querySelector('.marquee-seg')?.textContent || '') : (el.textContent || '');
        if (text === lastText) return;
        stop();
        buildStructure(text);
        if (banner && getComputedStyle(banner).display !== 'none') {
            start();
        }
    });
    observer.observe(el, { characterData: true, childList: true, subtree: true });

    const onResize = () => {
        const hasTrack = el._track && el.contains(el._track);
        const text = hasTrack ? (el._track.querySelector('.marquee-seg')?.textContent || '') : (el.textContent || '');
        const playing = !!rafId;
        stop();
        buildStructure(text);
        if (playing) start();
    };
    globalThis.addEventListener('resize', onResize);
    el._disposeMarquee = () => {
        try {
            globalThis.removeEventListener('resize', onResize);
        } catch (e) {
            console.debug('[Marquee] removeEventListener failed:', e);
        }
        try { if (observer) observer.disconnect(); } catch (e) { console.debug('[Marquee] observer.disconnect failed:', e); }
        try { stop(); } catch (e) { console.debug('[Marquee] stop failed:', e); }
    }
}

function changeScheduleClass(classHtml, inner) {
    if (scheduleData.currentHighlight.isEnd)
        classHtml += `<div class="class" id="highlighted" style="color:rgba(166,166,166);">${inner}</div>`
    else if (scheduleData.currentHighlight.type === 'current')
        // 根据网络连接状态设置当前课程的类
        classHtml += `<div class="class current ${wsConnected ? '' : 'disconnected'}" id="highlighted">${inner}</div>`
    else if (scheduleData.currentHighlight.type === 'upcoming')
        // 根据网络连接状态设置即将到来课程的类
        classHtml += `<div class="class upcoming ${wsConnected ? '' : 'disconnected'}" id="highlighted">${inner}</div>`
    return classHtml
}

function setScheduleClass() {
    let classHtml = '';
    for (let i = 0; i < scheduleData.scheduleArray.length; i++) {
        let inner = scheduleData.scheduleArray[i]
        if (scheduleData.currentHighlight.index === i) {
            classHtml = changeScheduleClass(classHtml, inner)
        } else if (scheduleData.currentHighlight.index > i)
            classHtml += `<div class="class" style="color:rgba(166,166,166);">${inner}</div>`
        else
            classHtml += `<div class="class">${inner}</div>`
        if (scheduleData.divider.includes(i))
            classHtml += '<div class="divider"></div>'
    }
    classContainer.innerHTML = classHtml

    // 使用统一规则设置 banner
    setBanner();
}

function setBackgroundDisplay() {
    let elements = document.getElementsByClassName('background')
    let element;
    // 如果是当前课程且开启了隐藏，或者前台有窗口且是休息时间，则隐藏背景
    const shouldHide = (scheduleData.currentHighlight.type === 'current' && isClassHidden) ||
        (isForegroundFullscreen && scheduleData.currentHighlight.type !== 'current');
    for (element of elements) {
        element.style.visibility = shouldHide ? 'hidden' : 'visible'
    }
}

function setCountdownerContent() {
    currentFullName.innerText = scheduleData.currentHighlight.fullName;
    // 根据连接状态和课程类型设置颜色
    if (scheduleData.currentHighlight.type === 'current') {
        // 当前课程：如果连接正常为绿色，连接异常时为橙色
        currentFullName.style.color = wsConnected ? 'rgba(0, 255, 10, 1)' : 'rgba(255, 165, 0, 1)';
    } else {
        // 非当前课程保持黄色
        currentFullName.style.color = 'rgba(255, 255, 5, 1)';
    }
    countdownText.innerText = scheduleData.currentHighlight.countdownText;

    const globalContainer = document.getElementById('globalContainer');

    if (scheduleData.currentHighlight.type === 'current') {
        if (isClassCountdown) {
            if (isClassHidden) { // 上课 并且开启了倒计时 并且 隐藏主体 -> 显示小窗口
                countdownContainer.style.display = 'none'
                miniCountdown.style.display = 'block'
                if (globalContainer) globalContainer.style.display = 'none'
                // 仅渲染文本，避免对 currentFullName.innerText 的副作用
                // 根据网络连接状态设置currentClass的颜色
                const currentClassColor = wsConnected ? 'rgba(0, 255, 10, 1)' : 'rgba(255, 165, 0, 1)';
                miniCountdown.innerHTML = `<div class="currentClass" style="color: ${currentClassColor}">${scheduleData.currentHighlight.fullName}</div><div class="countdown" style="margin-left:5px">${scheduleData.currentHighlight.countdownText}</div>`
            } else { // 上课 并且开启了倒计时 并且 不隐藏主体 -> 正常计时
                countdownContainer.style.display = 'block'
                miniCountdown.style.display = 'none'
                if (globalContainer) globalContainer.style.display = 'block'
            }
        } else { // 上课 并且关闭了倒计时 -> 都不显示
            countdownContainer.style.display = 'none'
            miniCountdown.style.display = 'none'
            if (globalContainer) globalContainer.style.display = 'none'
        }
    } else if (isForegroundFullscreen || isAlwaysMinimized) {
        countdownContainer.style.display = 'none'
        miniCountdown.style.display = 'block'
        if (globalContainer) globalContainer.style.display = 'none'
        const currentClassColor = wsConnected ? 'rgba(255, 255, 5, 1)' : 'rgba(255, 165, 0, 1)';
        const nextClass = scheduleData.nextScheduleName || '明天';  // “明天” 意味着今天的课程已经结束
        miniCountdown.innerHTML = `<div class="currentClass" style="color: ${currentClassColor}">${scheduleData.currentHighlight.fullName}</div><div class="countdown" style="margin-left:5px">${scheduleData.currentHighlight.countdownText}</div> | 下一节：<span class="class upcoming" id="highlighted">${nextClass}</span>`
    } else {
        countdownContainer.style.display = 'block';
        miniCountdown.style.display = 'none'
        if (globalContainer) globalContainer.style.display = 'block'
    }
}

function setCountdownerPosition() {
    let offset = {};
    const dividerWidth = Number(getComputedStyle(root).getPropertyValue('--divider-width').replace('px', ''));
    const dividerMargin = Number(getComputedStyle(root).getPropertyValue('--divider-margin').replace('px', ''));
    // 获取容器宽度，如果容器是隐藏的，临时显示它以获取正确的宽度
    if (countdownContainer.style.display === 'none') {
        const originalDisplay = countdownContainer.style.display;
        countdownContainer.style.display = 'block';
        cacheCountdownContainerOffsetWidth = countdownContainer.offsetWidth;
        countdownContainer.style.display = originalDisplay;
    } else {
        cacheCountdownContainerOffsetWidth = countdownContainer.offsetWidth;
    }
    let highlightElement = document.getElementById('highlighted');
    if (!highlightElement) return;

    const marginLeft = Number(getComputedStyle(highlightElement).marginLeft.replace('px', ''));
    if (scheduleData.currentHighlight.type === 'current') {
        offset = {
            x: highlightElement.offsetLeft - cacheCountdownContainerOffsetWidth / 2 + highlightElement.offsetWidth / 2,
            y: classContainer.offsetHeight
        };
    } else if (scheduleData.currentHighlight.type === 'upcoming') {
        if (scheduleData.currentHighlight.index !== 0 && scheduleData.divider.includes((scheduleData.currentHighlight.index - 1))) {
            offset = {
                x: highlightElement.offsetLeft - cacheCountdownContainerOffsetWidth / 2 - marginLeft - dividerWidth / 2 - dividerMargin,
                y: classContainer.offsetHeight
            };
        } else {
            offset = {
                x: highlightElement.offsetLeft - cacheCountdownContainerOffsetWidth / 2 - marginLeft,
                y: classContainer.offsetHeight
            };
        }
    }

    if (scheduleData.currentHighlight.isEnd) {
        offset = {
            x: highlightElement.offsetLeft - cacheCountdownContainerOffsetWidth / 2 + highlightElement.offsetWidth + marginLeft,
            y: classContainer.offsetHeight
        };
    }

    // 临时禁用过渡效果，避免初始位置设置时触发动画
    const originalTransition = countdownContainer.style.transition;
    countdownContainer.style.transition = 'none';

    countdownContainer.style.left = offset.x + 'px';
    countdownContainer.style.top = offset.y + 'px';
    countdownContainer.style.transform = 'none';

    // 强制重绘，确保位置立即生效
    countdownContainer.offsetHeight;

    // 恢复过渡效果
    countdownContainer.style.transition = originalTransition;
}

function setSidebar() {
    let date = getCurrentEditedDate()
    let week = date.getDay()
    let data = scheduleConfig.daily_class[week]
    weekCH.innerText = data.Chinese
    weekEN.innerText = data.English
    if (scheduleConfig.countdown_target === 'hidden') {
        rightSidebar.style.display = 'block'
        countdownDays.innerText = (date.getMonth() + 1) + " 月 " + date.getDate() + " 日"
        corunit.innerText = ""
    } else {
        rightSidebar.style.display = 'block'
        // 使用本地零点对齐的天数差，避免 UTC 字符串解析导致的 8:00 偏移
        const targetLocal = parseCountdownTargetLocal(scheduleConfig.countdown_target)
        if (targetLocal) {
            const days = Math.abs(dayDiffLocal(date, targetLocal))
            countdownDays.innerText = String(days)
        } else {
            // 回退行为：无法解析则显示 '-'，避免误导
            countdownDays.innerText = '-'
        }
        // 切回倒计时时恢复单位
        corunit.innerText = '天'
    }
    leftSidebar.style.display = scheduleConfig.week_display ? 'block' : 'none'
    ipcRenderer.send('getWeather', false)
}

function tick(reset = false) {
    scheduleData = getScheduleData();
    setCountdownerContent()
    if (JSON.stringify(scheduleData.scheduleArray) !== JSON.stringify(lastScheduleData.scheduleArray) ||
        scheduleData.currentHighlight.index !== lastScheduleData.currentHighlight.index ||
        scheduleData.currentHighlight.fullName !== lastScheduleData.currentHighlight.fullName ||
        scheduleData.currentHighlight.type !== lastScheduleData.currentHighlight.type || reset) {
        setScheduleClass()
        // 使用 requestAnimationFrame 确保 DOM 完全渲染后再计算位置
        requestAnimationFrame(() => {
            setCountdownerPosition()
        })
        setSidebar()
        setBackgroundDisplay()
        // 课程状态变化时，通知主进程更新全屏检测状态
        notifyMainProcessDetectionState();
    } else if (lastScheduleData.wsConnected !== wsConnected) {
        // 即使没有课程变化，如果连接状态变化，也需要更新颜色
        updateClassHighlightColors(wsConnected);
        updateUIColorsForConnectionStatus(wsConnected);
    }
    // noinspection JSUnresolvedReference
    lastScheduleData = $.extend(true, {}, scheduleData);
    lastScheduleData.wsConnected = wsConnected; // 保存连接状态用于比较
}

// 通知主进程当前是否应该检测全屏状态
// 当开启"上课隐藏"且处于上课状态时，不需要检测全屏
// 只在状态真正改变时才发送 IPC 消息
let lastShouldDetectFullscreen = null;

function notifyMainProcessDetectionState() {
    try {
        const shouldDetect = !((isClassHidden && scheduleData.currentHighlight.type === 'current') || isAlwaysMinimized);
        // 只在状态真正改变时才发送 IPC 消息
        if (shouldDetect !== lastShouldDetectFullscreen) {
            lastShouldDetectFullscreen = shouldDetect;
            ipcRenderer.send('fullscreen-detection-state', {shouldDetect});
        }
    } catch (e) {
        console.error('[Renderer] Failed to notify main process about detection state:', e);
    }
}

// 使用对齐系统秒的调度，避免 20ms 轮询
function scheduleNextTick() {
    const now = Date.now();
    const delay = 1000 - (now % 1000);
    setTimeout(() => {
        tick();
        scheduleNextTick();
    }, delay);
}

// 初始样式应用与事件注册改为 DOMContentLoaded 后执行
async function initDomAndStart() {
    // 启动时读取用户配置并与默认配置深合并
    await loadAndMergeUserConfig();

    // 绑定 DOM 引用
    classContainer = document.getElementById('classContainer')
    countdownContainer = document.getElementById('countdownContainer')
    corunit = document.getElementById('corunit')
    currentFullName = document.getElementById('currentFullName')
    countdownText = document.getElementById('countdownText')
    weekEN = document.getElementById('weekEN')
    weekCH = document.getElementById('weekCH')
    countdownDays = document.getElementById('countdownDays')
    miniCountdown = document.getElementById('miniCountdown')
    rightSidebar = document.getElementById('rightSidebar')
    leftSidebar = document.getElementById('leftSidebar')
    temperature = document.getElementById('temperature')
    weather = document.getElementById('weather')
    bannerText = document.getElementById('bannerText')
    banner = document.getElementById('banner')
    root = document.querySelector(':root');
    // 临时显示容器以获取正确的 offsetWidth
    const originalDisplay = countdownContainer?.style?.display || '';
    if (countdownContainer) {
        countdownContainer.style.display = 'block';
        cacheCountdownContainerOffsetWidth = countdownContainer.offsetWidth;
        countdownContainer.style.display = originalDisplay;
    } else {
        cacheCountdownContainerOffsetWidth = 0;
    }

    // 初始化跑马灯能力（此顺序确保 start/stop 方法存在）
    initBannerMarquee();

    // 首次应用配置样式（基于合并后的 scheduleConfig）
    for (const key in scheduleConfig.css_style) {
        root.style.setProperty(key, scheduleConfig.css_style[key])
    }
    // 记录默认 banner 高度（用于从 0 恢复）
    defaultBannerHeight = (scheduleConfig?.css_style?.['--banner-height'])
        || getComputedStyle(document.documentElement).getPropertyValue('--banner-height').trim()
        || '32px'

    // 鼠标移动监听（依赖 root）
    // 统一切换透明度（不再在此切换点击穿透）
    function setDimmed(dim) {
        if (!root) return;
        root.style.opacity = dim ? '0.1' : '1';
    }

    // 仅当悬浮在特定元素上时降低透明度
    function getHoverCandidates() {
        return [
            classContainer,
            countdownContainer?.style?.display !== 'none' ? countdownContainer : null,
            miniCountdown?.style?.display !== 'none' ? miniCountdown : null,
            leftSidebar?.style?.display !== 'none' ? leftSidebar : null,
            rightSidebar?.style?.display !== 'none' ? rightSidebar : null,
            banner?.style?.display !== 'none' ? banner : null,
        ].filter(Boolean)
    }

    function isTargetInCandidates(target) {
        if (!target) return false
        const candidates = getHoverCandidates()
        for (const el of candidates) {
            if (el?.contains?.(target)) return true
        }
        return false
    }

    // 事件委托：基于 event.target 判定（若点击穿透导致收不到事件，下面的轮询仍可生效）
    globalThis.addEventListener('mousemove', (e) => {
        setDimmed(isTargetInCandidates(e?.target || null))
    })

    // 当鼠标离开窗口或页面失焦时，恢复正常透明度
    globalThis.addEventListener('mouseout', () => {
        setDimmed(false);
    });
    globalThis.addEventListener('blur', () => setDimmed(false));
    document.addEventListener('mouseleave', () => setDimmed(false));
    document.addEventListener('pointerleave', () => setDimmed(false));

    // 初始设置：正常透明度 + 永远开启点击穿透
    setDimmed(false)
    ipcRenderer.send('setIgnore', true)

    // 轮询：在点击穿透下，依据光标与窗口边界将坐标换算为页面坐标，仅当光标落入候选元素矩形内才变暗
    let hoverTimer = null
    let lastDimmed = null

    function isClientHovering(clientX, clientY) {
        const candidates = getHoverCandidates()
        for (const el of candidates) {
            const r = el?.getBoundingClientRect?.()
            if (!r) continue
            if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return true
        }
        return false
    }
    async function pollHover(){
        try {
            const data = await ipcRenderer.invoke('getCursorAndBounds')
            const dpr = globalThis.devicePixelRatio || 1
            const cx = (data?.cursor?.x ?? 0) - (data?.bounds?.x ?? 0)
            const cy = (data?.cursor?.y ?? 0) - (data?.bounds?.y ?? 0)
            let hovering = isClientHovering(cx, cy)
            if (!hovering && dpr !== 1) {
                hovering = isClientHovering(cx / dpr, cy / dpr) || isClientHovering(cx * dpr, cy * dpr)
            }
            if (hovering !== lastDimmed) {
                setDimmed(!!hovering)
                lastDimmed = !!hovering
            }
        } catch {}
    }
    hoverTimer = setInterval(pollHover, 100)
    globalThis.addEventListener('beforeunload', () => {
        try {
            clearInterval(hoverTimer)
        } catch {
        }
    })

    // 尝试应用一次 banner，以处理初始化前产生的更新
    setBanner();

    // 初始化 countdownContainer 的位置为居中，避免动画从左侧开始
    if (countdownContainer && classContainer) {
        countdownContainer.style.left = '50%';
        countdownContainer.style.transform = 'translateX(-50%)';
    }

    // 启动心跳渲染（在合并配置后再启动）
    scheduleNextTick();

    // 确保当前连接状态的颜色被正确应用
    if (wsConnected !== undefined) {
        updateUIColorsForConnectionStatus(wsConnected);
    }
}

globalThis.addEventListener('DOMContentLoaded', () => {
    initDomAndStart().catch(() => {
    })
})

function setScheduleDialog() {
    ipcRenderer.send('dialog', {
        reply: 'getSelectedClassIndex',
        options: {
            title: '更改课表',
            message: `请选择你要更改的课程序号`,
            buttons: scheduleData.scheduleArray.map((value, index) => { return `第 ${index + 1} 节: ${scheduleConfig.subject_name[value]}` }),
            cancelId: -1,
            defaultId: scheduleData.currentHighlight.index
        }
    })
}

ipcRenderer.on('getSelectedClassIndex', (e, arg) => {
    if (arg.index === -1) return
    let classes = Object.keys(scheduleConfig.subject_name).sort((a,b)=>a.localeCompare(b));
    ipcRenderer.send('dialog', {
        reply: 'getSelectedChangingClass',
        index: arg.index,
        classes: classes,
        options: {
            title: '更改课表',
            message: `将 第 ${arg.index + 1} 节 ${scheduleConfig.subject_name[scheduleData.scheduleArray[arg.index]]} 更改为:`,
            buttons: classes.map((value) => { return scheduleConfig.subject_name[value] }),
            cancelId: -1,
        }
    })
})

ipcRenderer.on('getSelectedChangingClass', (e, arg) => {
    if (arg.index === -1) return
    let index = arg.arg.index;
    let selectedClass = arg.arg.classes[arg.index];
    const date = getCurrentEditedDate();
    const dayOfWeek = getCurrentEditedDay(date);
    scheduleConfig.daily_class[dayOfWeek].classList[index] = selectedClass;
    // 不持久化：改课仅在本次会话有效
})

ipcRenderer.on('openSettingDialog', () => {
    setScheduleDialog()
})

document.addEventListener("click", function (event) {
    if (event?.target?.classList?.contains('options')) {
        ipcRenderer.send('pop')
    }
});

ipcRenderer.on('setWeekIndex', (e, arg) => {
    scheduleConfig = structuredClone(_scheduleConfig)
    weekIndex = arg
    localStorage.setItem('weekIndex', weekIndex.toString())
})

ipcRenderer.on('getWeekIndex', () => {
    let index = localStorage.getItem('weekIndex');
    ipcRenderer.send('getWeekIndex', index === null ? 0 : Number(index))
})

ipcRenderer.on('getTimeOffset', () => {
    let offset = localStorage.getItem('timeOffset');
    ipcRenderer.send('getTimeOffset', offset === null ? 0 : Number(offset))
})

ipcRenderer.on('setTimeOffset', (e, arg) => {
    timeOffset = arg
    localStorage.setItem('timeOffset', arg.toString())
})

ipcRenderer.on('fromCloud', () => {
    let uri = localStorage.getItem('server');
    ipcRenderer.send('fromCloud', uri === null ? "class.khbit.cn" : uri.toString())
})

ipcRenderer.on('setClass', () => {
    let uri = localStorage.getItem('class');
    ipcRenderer.send('setClass', uri === null ? "39/2023/1" : uri.toString())
})

ipcRenderer.on('setCloudUrl', (e, arg) => {
    localStorage.setItem('server', arg.toString())
})

ipcRenderer.on('setCloudClass', (e, arg) => {
    localStorage.setItem('class', arg.toString())
})

ipcRenderer.on('setCloudSec', (e, arg) => {
    // 渲染层仅记录标志，具体生效由主进程维护
    isSecureConnection = !!arg
    console.log('[Renderer] setCloudSec =', isSecureConnection)
})

// 小函数：温度与天气状态更新
function applyTemperature(arg){
    if (!temperature || !weather) return; // DOM 未就绪时跳过，避免警告
    const t = Number(arg['temp'])
    temperature.innerText = (Number.isNaN(t) ? '-' : t) + "℃"
    if (!Number.isNaN(t)) {
        if (t < 24) temperature.style.color = "#66CCFF"
        else if (t <= 26) temperature.style.color = "#5FBC21"
        else temperature.style.color = "#EE0000"
    }
    weather.innerText = String(arg['weat'] ?? '')
}

// 辅助：标准化字符串
function normalizeStr(x){
    return (typeof x === 'string') ? x.trim() : ''
}
// 辅助：键名是否看起来是预警字段
function looksWarnKey(key, useBrief){
    const kl = String(key || '').toLowerCase()
    const hasWarn = kl.includes('warn') || kl.includes('alert')
    if (!hasWarn) return false
    return useBrief ? kl.includes('brief') : true
}

// 小函数：选择天气预警文本
function pickWeatherWarn(data, useBrief){
    if (!data) return ''
    const direct = normalizeStr(useBrief ? data['brief_warn'] : '') || normalizeStr(data.warn)
    if (direct) return direct
    let best = ''
    for (const [k, v] of Object.entries(data)){
        if (!looksWarnKey(k, useBrief)) continue
        const vv = normalizeStr(v)
        if (vv && vv.length > best.length) best = vv
    }
    return best
}

// 根据最近一次天气数据与当前配置，立即重算并应用预警文本（不等待下一次天气推送）
function recomputeWeatherWarnFromLast() {
    if (!lastWeatherPayload) return false;
    const useBrief = !!scheduleConfig.weather_alert_brief;
    weatherWarn = pickWeatherWarn(lastWeatherPayload, useBrief);
    weatherWarnTs = Date.now();
    return true;
}

ipcRenderer.on('newConfig', (e, arg) => {
    // 云端下发的配置仅在当前会话生效，不写入本地用户配置
    scheduleConfig = arg
    for (const key in scheduleConfig.css_style) {
        root.style.setProperty(key, scheduleConfig.css_style[key])
    }
    scheduleData = getScheduleData();
    setScheduleClass()
    setSidebar()
    // 配置变化也需应用覆盖规则
    // 若开启预警覆盖并切换了简略/详细模式，立即基于最近一次天气数据重算，避免等待下一次天气刷新
    if (scheduleConfig.weather_alert_override) {
        const ok = recomputeWeatherWarnFromLast();
        if (!ok) {
            try {
                ipcRenderer.send('getWeather', false)
            } catch {
            }
        }
    }
    setBanner();
})

ipcRenderer.on('ClassCountdown', (e, arg) => {
    isClassCountdown = arg
    tick(true)
})

ipcRenderer.on('ClassHidden', (e, arg) => {
    isClassHidden = arg
    tick(true)
})

ipcRenderer.on('AlwaysMinimized', (e, arg) => {
    isAlwaysMinimized = arg
    tick(true)
})

ipcRenderer.on('setDayOffset', () => {
    ipcRenderer.send('dialog', {
        reply: 'getDayOffset',
        options: {
            title: '切换日程',
            message: `将今日使用课表日程设置为本周的星期几：`,
            buttons: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '重置至当前日期'],
            cancelId: -1,
        }
    })
})

ipcRenderer.on('getDayOffset', (e, arg) => {
    if (arg.index === -1) return
    if (arg.index <= 6) {
        localStorage.setItem('dayOffset', arg.index.toString())
        localStorage.setItem('setDayOffsetLastDay', new Date().getDay().toString())
        // noinspection JSUndeclaredVariable
        dayOffset = arg.index
        // noinspection JSUndeclaredVariable
        setDayOffsetLastDay = new Date().getDay()
        return
    }
    localStorage.setItem('dayOffset', '-1')
    localStorage.setItem('setDayOffsetLastDay', '-1')
    dayOffset = -1
    setDayOffsetLastDay = -1
})

ipcRenderer.on('setWeather', (e, arg) => {
    applyTemperature(arg)

    const useBrief = !!scheduleConfig.weather_alert_brief;
    const candidate = pickWeatherWarn(arg, useBrief)

    // 记录最近一次天气原始数据，供配置切换时立即重算
    lastWeatherPayload = arg

    const ts = Date.now();
    if (ts >= weatherWarnTs) {
        weatherWarnTs = ts;
        weatherWarn = candidate;
        console.log('[Weather] ts=', ts, 'briefMode=', useBrief, 'warn=', weatherWarn, 'override=', !!scheduleConfig.weather_alert_override);
        setBanner();
    } else {
        console.log('[Weather] drop outdated ts=', ts, 'currentTs=', weatherWarnTs, 'candidate=', candidate);
    }
})

ipcRenderer.on('updateWeather', () => {
    ipcRenderer.send('getWeather', false)
})

ipcRenderer.on('broadcastSyncConfig', () => {
    ipcRenderer.send('RequestSyncConfig', false)
})

// WebSocket连接状态处理
let wsConnected = true; // 默认为连接状态

// 前台窗口全屏状态处理
let isForegroundFullscreen = false; // 默认为非全屏状态

ipcRenderer.on('foreground-fullscreen-changed', (e, arg) => {
    const wasFullscreen = isForegroundFullscreen;
    isForegroundFullscreen = arg.isFullscreen;

    console.log('[Renderer] Foreground fullscreen status changed:', isForegroundFullscreen);

    // 当状态变化时，可以在此处调整 UI 显示
    // 比如全屏时显示简略信息，非全屏时显示详细信息
    updateUIForFullscreenStatus(isForegroundFullscreen);
});

// 根据前台窗口全屏状态更新 UI
function updateUIForFullscreenStatus(isFullscreen) {
    console.log('[Renderer] Updating UI for fullscreen status:', isFullscreen);
    // 状态变化时刷新 UI
    tick(true);
}


ipcRenderer.on('ws-status', (e, arg) => {
    const wasConnected = wsConnected;
    wsConnected = arg.connected;

    console.log('[Renderer] WebSocket status changed:', wsConnected);

    // 如果是连接状态变化，更新UI状态
    if (wasConnected !== wsConnected) {
        if (wsConnected) {
            // 连接恢复，更新UI颜色为绿色
            console.log('[Renderer] WebSocket reconnected, updating UI to show connected state');
            updateUIColorsForConnectionStatus(true);
        } else {
            // 连接断开，更新UI颜色为橙色
            console.log('[Renderer] WebSocket disconnected, updating UI to show warning state');
            updateUIColorsForConnectionStatus(false);
        }
    }
});

// 根据连接状态更新UI颜色
function updateUIColorsForConnectionStatus(connected) {
    console.log('[Renderer] Updating UI colors for connection status:', connected);

    if (currentFullName && scheduleData?.currentHighlight?.type) {
        if (scheduleData.currentHighlight.type === 'current') {
            // 根据连接状态设置颜色：连接时为绿色，断开时为橙色
            currentFullName.style.color = connected ? 'rgba(0, 255, 10, 1)' : 'rgba(255, 165, 0, 1)';
            console.log('[Renderer] Set currentFullName color to', connected ? 'green' : 'orange');
        } else {
            currentFullName.style.color = 'rgba(255, 255, 5, 1)'; // 非当前课程保持黄色
        }
    } else {
        console.log('[Renderer] currentFullName or scheduleData not ready, deferring color update');
    }

    // 更新课表高亮颜色
    updateClassHighlightColors(connected);
}

// 更新miniCountdown中的currentClass颜色
function updateMiniCountdownColor(connected) {
    if (miniCountdown && miniCountdown.style.display !== 'none') {
        const currentClassElement = miniCountdown.querySelector('.currentClass');
        if (currentClassElement) {
            currentClassElement.style.color = connected ? 'rgba(0, 255, 10, 1)' : 'rgba(255, 165, 0, 1)';
            console.log('[Renderer] Updated miniCountdown currentClass color to', connected ? 'green' : 'orange');
        }
    }
}

// 更新课表高亮颜色
function updateClassHighlightColors(connected) {
    const highlightedElement = document.getElementById('highlighted');
    if (!highlightedElement) {
        console.log('[Renderer] No highlighted element found, cannot update class colors');
        return;
    }

    console.log('[Renderer] Updating highlighted element color for connection status:', connected);

    if (highlightedElement.classList.contains('current')) {
        highlightedElement.style.color = connected ? 'rgba(0, 255, 10, 1)' : 'rgba(255, 165, 0, 1)';
        console.log('[Renderer] Set current class color to', connected ? 'green' : 'orange');
    } else if (highlightedElement.classList.contains('upcoming')) {
        // 对于即将到来的课程，根据连接状态设置颜色和动画
        if (connected) {
            // 移除disconnected类以使用绿色闪烁动画
            highlightedElement.classList.remove('disconnected');
            highlightedElement.style.color = 'rgba(0, 255, 10, 1)';
            // 重新启动动画
            highlightedElement.classList.remove('upcoming');
            void highlightedElement.offsetWidth; // 强制重排以重新启动动画
            highlightedElement.classList.add('upcoming');
            console.log('[Renderer] Set upcoming class to connected state with green animation');
        } else {
            // 添加disconnected类以使用橙色闪烁动画
            highlightedElement.classList.add('disconnected');
            highlightedElement.style.color = 'rgba(255, 165, 0, 1)';
            console.log('[Renderer] Set upcoming class to disconnected state with orange animation');
        }
    }

    // 同时更新miniCountdown的颜色
    updateMiniCountdownColor(connected);
}

// 更新ToolTip显示连接状态

// 处理从主进程发送的tray状态更新事件
ipcRenderer.on('update-tray-status', (e, arg) => {
    // 实际上这个事件处理在这里不需要，因为更新tray tooltip是主进程的任务
    // 渲染进程只需要关注UI颜色更新
    console.log('[Renderer] Tray status update received:', arg);
});
// 辅助：确保 banner 高度可见
function ensureBannerHeight(){
    if (!root) return; // 未初始化时跳过
    const configuredBannerH = scheduleConfig?.css_style?.['--banner-height'];
    const currentH = getComputedStyle(document.documentElement).getPropertyValue('--banner-height').trim();
    const desiredH = (configuredBannerH || defaultBannerHeight || '32px');
    if (!currentH || currentH === '0' || currentH === '0px') {
        root.style.setProperty('--banner-height', desiredH);
    }
}

function resetMarqueeTrack(){
    if (!bannerText) return;
    if (bannerText._track && bannerText.contains(bannerText._track)) {
        bannerText._track.remove()
    }
    bannerText._track = null;
}

function showBanner(text){
    if (!banner || !bannerText) return;
    banner.style.display = 'flex';
    ensureBannerHeight();
    resetMarqueeTrack();
    if (typeof bannerText.stop === 'function') bannerText.stop();
    if (typeof bannerText.start === 'function') bannerText.start();
    console.log('[Banner] show override=', !!scheduleConfig.weather_alert_override, 'text=', text, 'height=', getComputedStyle(document.documentElement).getPropertyValue('--banner-height'));
}

function hideBanner(){
    if (!banner || !bannerText || !root) return;
    banner.style.display = 'none';
    if (typeof bannerText.stop === 'function') bannerText.stop();
    root.style.setProperty('--banner-height', 0);
    console.log('[Banner] hide override=', !!scheduleConfig.weather_alert_override, 'text empty');
}

// 统一控制 banner 文本与动画（天气预警覆盖）
function setBanner() {
    // DOM 未就绪则跳过，避免在初始化前触发动画 API
    if (!bannerText || !banner || !root) return;

    const override = !!scheduleConfig.weather_alert_override;
    const text = override ? (weatherWarn || '') : (scheduleConfig.banner_text || '');

    if (text && text !== bannerText.innerText) {
        bannerText.innerText = text;
    }

    if (text) {
        showBanner(text)
    } else {
        hideBanner()
    }
}
