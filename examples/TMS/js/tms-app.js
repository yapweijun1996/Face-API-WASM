/**
 * tms-app.js
 * ----------
 * 人脸考勤系统（Time Management System）示例主逻辑。
 *
 * 复用项目核心模块：
 *   FaceRegistrationManager —— 员工人脸注册状态机
 *   FaceMatcher             —— 1:N 人脸比对（打卡识别）
 *   tmsDB                   —— 员工 / 考勤的 IndexedDB + 设置 localStorage
 *
 * 检测器用 TinyFaceDetector（手机 / iPad 上更快）。
 */

(() => {
    'use strict';

    // ---------- 路径（相对 examples/TMS/） ----------
    const BASE = '../../';
    const MODEL_URL = BASE + 'models';
    const WASM_PATH = BASE + 'js/lib/';

    const SAFE_MATCH_THRESHOLD = 0.32;
    const WEAK_MATCH_WARN_MS = 3000;      // 弱匹配 console.warn 的每员工限流间隔，避免逐帧刷屏
    const SPOOF_HOLD_MS = 2000;           // 判伪/失败后停留多久再重置重试，给用户看清提示
    // 每个 face track 锁定员工后，按 1fps 抓满 3 张真帧才写记录 / 送 AI。
    const VLM_FRAME_COUNT = 3;
    const VLM_FRAME_INTERVAL_MS = 1000;
    // 送审帧保留足够分辨率，避免手机边框/屏幕反光/moire 在缩图里被压没。
    const VLM_FRAME_MAXEDGE = 768;       // 送审帧最长边（px）
    const VLM_FRAME_QUALITY = 0.78;      // 送审帧 JPEG 质量
    const BLANK_FRAME_LUMA = 16;         // 平均亮度低于此（0-255）视为黑帧：摄像头预热/重开瞬间会吐黑帧，丢弃不入缓冲
    // 打卡前的人脸构图闸门：活体 VLM 需要看到整帧环境（手、屏幕边框、打印纸边缘等），
    // 所以人脸不能贴满镜头；同时要求大致居中，避免半张脸/偏边缘画面触发核验。
    const FACE_FRAMING = {
        minHeightRatio: 0.16,
        maxHeightRatio: 0.62,
        maxAreaRatio: 0.28,
        maxCenterOffsetX: 0.22,
        maxCenterOffsetY: 0.28
    };
    const GEOMETRY_SUSPECT_THRESHOLD = 0.72;

    // ---------- 运行状态 ----------
    let settings = tmsDB.getSettings();
    if (settings.matchThreshold > SAFE_MATCH_THRESHOLD) {
        settings = tmsDB.saveSettings({ matchThreshold: SAFE_MATCH_THRESHOLD });
    }
    let matcher = null;
    let empPhotos = new Map();        // employeeId -> 脸部缩略图 dataURL，供打卡卡片显示
    let regManager = null;
    // VLM 活体核验客户端（MiniCPM-V via LM Studio）。按需初始化（健康检查）：
    //  - null：未初始化；非 null 且 .ready 表示 LM Studio 可达
    let liveness = null;
    let livenessInitPromise = null;   // 单飞，避免并发重复初始化
    let gating = false;               // AI 核验进行中：暂停人脸检测（弹窗 + 纯等待，省资源）
    let clockEpoch = 0;               // 每次开/关摄像头 +1；核验回调据此判断是否仍属同一会话
    let frameRing = [];               // 滚动帧缓冲 [{t, url}]，持续以 1fps 缓存最近画面
    let lastFrameCapAt = 0;           // 上次往缓冲抓帧的时间
    let appMode = 'idle';            // 'idle' | 'clock' | 'enroll'
    let stream = null;
    let activeVideo = null;
    let loopHandle = null;
    let detecting = false;

    // 打卡防抖：记录每个员工最近一次成功打卡时间，冷却期内忽略
    const cooldown = new Map();
    const weakMatchWarnedAt = new Map();   // employeeId -> 上次弱匹配告警时间（限流，避免逐帧刷屏）
    let lastClockKey = null;          // 当前 clock 面板展示的员工，避免重复渲染

    // 实时打卡（自动）+ 真人检测状态
    const HOLD_MS = 1500;             // 对准保持多久自动打卡
    let lastClockDets = [];          // 最近一帧所有检测到的脸：[{ box, match, hold }]（多人）
    // 按「物理人脸位置」追踪，每个 track 的 .data 挂独立 hold/活体/倒计时；
    // 取代旧的「按员工 id」存状态——根治同一员工被两张脸（本人+照片/双胞胎）共享 hold。
    const tracker = new FaceTracker({ maxAgeMs: 1200, iouThreshold: 0.2 });
    let particles = [];              // 打卡成功的庆祝粒子
    let lastPrimaryId = null;        // 侧边卡片当前展示的员工（用于迟滞，避免抖动）

    // 叠加层颜色单一来源（与 CSS 的 --in/--out/--accent 对应）
    const COLORS = {
        in: '#22c55e',
        out: '#f43f5e',
        accent: '#22d3ee',
        warn: '#fbbf24',
        unmatched: 'rgba(148,163,184,.75)',
        overlayPanel: 'rgba(15,23,42,.85)',
        overlayText: '#fff',
        overlayTrack: 'rgba(255,255,255,.25)',
        celebrateIn: '#4ade80',
        celebrateLime: '#a3e635',
        celebrateOut: '#fb7185'
    };
    // canvas 未镜像、视频 CSS 镜像：把检测坐标的 x 翻转过来对齐镜像画面
    const mirrorX = (overlayW, x, w) => overlayW - x - w;

    const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

    // Random action challenges (blink/smile/head-turn/etc.) are banned for this project.
    // Stronger PAD should use passive VLM review, HR review, or a certified SDK/service.

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const el = {};
    function cacheDom() {
        [
            'bootOverlay', 'bootStatus', 'toast', 'updateBanner', 'reloadBtn',
            'clockVideo', 'clockOverlay', 'clockCard', 'clockHint', 'empCountPill', 'langBtn', 'themeBtn',
            'empList', 'empName', 'empDept', 'enrollBtn', 'empEmpty',
            'enrollModal', 'enrollVideo', 'enrollOverlay', 'enrollBar', 'enrollText',
            'enrollThumbs', 'enrollCancel', 'enrollTitle',
            'appModal',
            'recordsBody', 'recordsSummary', 'recordsEmpty', 'exportCsvBtn', 'clearRecordsBtn',
            'recordsFilter', 'recordsFilterChip', 'recordsPageSize', 'recordsPrevBtn', 'recordsNextBtn', 'recordsPageInfo',
            'thresholdInput', 'thresholdVal', 'thresholdLabel', 'initialMatchInput', 'initialMatchLabel', 'lockedMatchInput', 'lockedMatchLabel', 'livenessToggle',
            'vlmFields', 'livenessModeSelect', 'autoRetryToggle', 'showLivenessFramesToggle', 'realProbLabel', 'realProbVal', 'realProbInput', 'vlmEndpointInput', 'vlmModelInput',
            'verifyRunBtn', 'verifyRetryBtn', 'verifyScope', 'verifyProgress', 'verifyBar', 'verifyProgressText', 'reviewModal', 'reviewTitle', 'reviewFrames', 'reviewReason', 'reviewMarkBtn', 'reviewClose',
            'imageViewerModal', 'imageViewerTitle', 'imageViewerCounter', 'imageViewerClose', 'imageViewerStage', 'imageViewerImg',
            'imageViewerPrev', 'imageViewerNext', 'imageViewerZoomIn', 'imageViewerZoomOut', 'imageViewerZoomLabel',
            'soundToggle', 'soundFields', 'speakToggle', 'voiceSelect', 'voiceTestBtn', 'voiceFields',
            'livenessModal', 'lmCard', 'lmBadge', 'lmTitle', 'lmSub', 'lmBar', 'lmFrames',
            'workStartInput', 'workEndInput', 'graceInput',
            'statInNow', 'statLate', 'statStaff', 'whosInList', 'whosInEmpty', 'weeklyChart'
        ].forEach(id => { el[id] = $(id); });
    }

    // 引用 index.html 顶部 SVG 精灵里的图标；用于 JS 动态生成的 DOM。
    // 图标 id 固定、无用户数据，innerHTML 注入安全。dot 用实心圆（.ico.dot）。
    function icon(name) {
        const cls = name === 'dot' ? 'ico dot' : 'ico';
        return `<svg class="${cls}"><use href="#i-${name}"></use></svg>`;
    }

    function normalizeTheme(theme) {
        return theme === 'light' ? 'light' : 'dark';
    }

    function applyTheme(theme) {
        const next = normalizeTheme(theme);
        document.documentElement.dataset.theme = next;
        const css = getComputedStyle(document.documentElement);
        COLORS.in = css.getPropertyValue('--in').trim() || COLORS.in;
        COLORS.out = css.getPropertyValue('--out').trim() || COLORS.out;
        COLORS.accent = css.getPropertyValue('--accent').trim() || COLORS.accent;
        COLORS.warn = css.getPropertyValue('--warn').trim() || COLORS.warn;
        COLORS.unmatched = css.getPropertyValue('--muted').trim() || COLORS.unmatched;
        COLORS.overlayPanel = css.getPropertyValue('--overlay-panel').trim() || COLORS.overlayPanel;
        COLORS.overlayText = css.getPropertyValue('--overlay-text').trim() || COLORS.overlayText;
        COLORS.overlayTrack = css.getPropertyValue('--overlay-track').trim() || COLORS.overlayTrack;
        COLORS.celebrateIn = css.getPropertyValue('--celebrate-in').trim() || COLORS.celebrateIn;
        COLORS.celebrateLime = css.getPropertyValue('--celebrate-lime').trim() || COLORS.celebrateLime;
        COLORS.celebrateOut = css.getPropertyValue('--celebrate-out').trim() || COLORS.celebrateOut;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = next === 'light' ? '#f8fafc' : '#0f172a';
        if (el.themeBtn) {
            const iconName = next === 'light' ? 'moon' : 'sun';
            el.themeBtn.innerHTML = icon(iconName);
            el.themeBtn.setAttribute('aria-label', I18N.t(next === 'light' ? 'theme_switch_dark' : 'theme_switch_light'));
            el.themeBtn.title = I18N.t(next === 'light' ? 'theme_switch_dark' : 'theme_switch_light');
        }
    }

    function clampNumber(v, min, max, fallback) {
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    function normalizeIdentitySettings(src) {
        const initial = Math.round(clampNumber(src && src.initialMatchConfidence, 70, 95, 80));
        const lockedRaw = Math.round(clampNumber(src && src.lockedMatchConfidence, 45, 80, 60));
        return {
            initialMatchConfidence: initial,
            lockedMatchConfidence: Math.min(lockedRaw, initial)
        };
    }

    function saveIdentitySettings(patch) {
        const next = normalizeIdentitySettings({ ...settings, ...patch });
        settings = tmsDB.saveSettings(next);
        applySettingsToUi();
    }

    // ============================================================
    // 初始化
    // ============================================================
    async function boot() {
        cacheDom();
        settings = tmsDB.saveSettings(normalizeIdentitySettings(settings));
        settings.theme = normalizeTheme(settings.theme);
        applyTheme(settings.theme);
        TmsModal.init({ root: el.appModal, i18n: I18N, icon });
        I18N.apply();
        el.langBtn.textContent = I18N.other;
        I18N.onChange.push(onLangChange);
        wireUi();
        registerServiceWorker();
        if (settings.autoRetry) startAutoRetryPoll();   // 启用自动重试则开后台轮询

        try {
            setBoot(I18N.t('boot_backend'));
            if (typeof tf !== 'undefined' && tf.wasm && tf.wasm.setWasmPaths) {
                tf.wasm.setWasmPaths(WASM_PATH);
                await tf.setBackend('wasm');
                await tf.ready();
            } else {
                await faceapi.tf.setBackend('webgl');
                await faceapi.tf.ready();
            }

            setBoot(I18N.t('boot_models'));
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
                faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
            ]);

            setBoot(I18N.t('boot_warmup'));
            await warmup();

            setBoot(I18N.t('boot_employees'));
            await tmsDB.init();
            await reloadMatcher();

            // 注册管理器：不写入 FaceRegistrationDB，由 TMS 自己存
            regManager = new FaceRegistrationManager({
                maxCaptures: settings.enrollCaptures,
                captureInterval: 400,
                similarityThreshold: 0.12,
                consistencyThreshold: 0.5,
                autoSaveProgress: false
            });
            await regManager.init(null);
            wireRegManager();

            await renderEmployees();
            await renderRecords();
            applySettingsToUi();

            hideBoot();
            switchTab('clock');
        } catch (err) {
            console.error(err);
            setBoot(I18N.t('boot_fail', { msg: err.message }));
        }
    }

    /** 语言切换后重渲染动态内容 */
    function onLangChange() {
        el.langBtn.textContent = I18N.other;
        lastClockKey = null;                 // 强制 clock 卡片下次重渲染
        applySettingsToUi();
        renderEmployees();
        renderRecords();
        if (document.getElementById('panel-dashboard').classList.contains('show')) renderDashboard();
        const employees = matcher ? matcher.getUserCount() : 0;
        el.empCountPill.textContent = I18N.t('emp_count', { n: employees });
        if (appMode === 'clock' && (!matcher || matcher.getUserCount() === 0)) showClockIdle();
    }

    async function warmup() {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 120;
        await faceapi.detectSingleFace(c, detectorOptions());
    }

    /**
     * 按需初始化 VLM 活体核验客户端（单飞）并做健康检查（探测 LM Studio 是否在跑）。
     * 不可达不致命：降级放行（不锁死打卡），仅提示「核验不可用」。
     * @returns {Promise<object|null>} 就绪的 client（this.ready 反映可达性）或 null
     */
    function ensureLiveness() {
        if (liveness && liveness.ready) return Promise.resolve(liveness);
        if (livenessInitPromise) return livenessInitPromise;
        if (typeof TmsLiveness === 'undefined') {
            toast(I18N.t('liveness_engine_fail', { msg: 'TmsLiveness not loaded' }), 'err');
            return Promise.resolve(null);
        }
        livenessInitPromise = (async () => {
            const eng = new TmsLiveness.VlmLiveness({
                endpoint: settings.vlmEndpoint,
                model: settings.vlmModel,
                threshold: settings.livenessRealProb,
                maxEdge: 512
            });
            const prevHint = el.clockHint ? el.clockHint.textContent : '';
            if (el.clockHint && appMode === 'clock') el.clockHint.textContent = I18N.t('liveness_loading');
            const ok = await eng.health();
            liveness = eng;
            console.log('TMS VLM liveness:', { endpoint: eng.endpoint, model: eng.model, reachable: ok });
            if (ok) toast(I18N.t('liveness_loaded', { caps: eng.model }), 'ok');
            else toast(I18N.t('liveness_engine_fail', { msg: eng.endpoint }), 'err');
            if (el.clockHint && appMode === 'clock' && el.clockHint.textContent === I18N.t('liveness_loading')) {
                el.clockHint.textContent = prevHint;
            }
            return liveness;
        })().catch((e) => {
            console.error('TMS VLM liveness init failed', e);
            toast(I18N.t('liveness_engine_fail', { msg: e.message }), 'err');
            livenessInitPromise = null;   // 允许下次重试
            return null;
        });
        return livenessInitPromise;
    }

    /** 重置某 track 的活体读数（人脸框上的「真人置信度」，核验闸成功后写回）。 */
    function resetLiveness(d) {
        d.realProb = null;        // VLM confidence，供人脸框读数展示；其余核验态现由 gate 内的局部变量与 gating 管理
    }

    // ---- VLM 送审用的滚动帧缓冲（与 liveness 客户端解耦）----
    // 进入打卡页就持续以 1fps 抓整帧进缓冲（哪怕健康检查还没完成、哪怕人脸还没识别）。
    // 这样人脸一旦识别通过，「识别之前」的画面已经在缓冲里，直接取最近 N 帧送审，
    // 无需识别后再傻等 N 秒——这正是用户要的「取 t-3/-2/-1 秒」。
    let ringCanvas = null;

    /** 估算 canvas 平均亮度，判断是否黑帧（摄像头预热/重开瞬间会吐黑帧）。取不到像素则不拦。 */
    function frameTooDark(canvas) {
        try {
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let sum = 0, n = 0;
            for (let i = 0; i < data.length; i += 16 * 4) {   // 每 16 像素稀疏采样，够估均值且快
                sum += data[i] + data[i + 1] + data[i + 2]; n += 3;
            }
            return n > 0 && (sum / n) < BLANK_FRAME_LUMA;
        } catch (e) { return false; }
    }

    /** 抓一帧送审用的整帧（压缩 + 黑帧过滤）。黑帧返回 null。 */
    function grabSendFrame() {
        if (typeof TmsLiveness === 'undefined' || !activeVideo) return null;
        if (!ringCanvas) ringCanvas = document.createElement('canvas');
        const url = TmsLiveness.captureVideoFrame(activeVideo, { maxEdge: VLM_FRAME_MAXEDGE, jpegQuality: VLM_FRAME_QUALITY, canvas: ringCanvas });
        if (!url || frameTooDark(ringCanvas)) return null;   // 丢弃黑帧
        return url;
    }

    function captureRingFrame(now) {
        if (appMode !== 'clock' || !activeVideo) return;
        if (now - lastFrameCapAt < VLM_FRAME_INTERVAL_MS) return;   // 限流到 1fps
        const url = grabSendFrame();
        if (!url) return;   // 黑帧不入缓冲；不推进 lastFrameCapAt，下个 tick 立即重试，尽快补上真帧
        lastFrameCapAt = now;
        frameRing.push({ t: now, url });
        // 兼容保留少量全局帧，实际打卡记录使用每个 track 自己的 captureFrames。
        const cutoff = now - (VLM_FRAME_INTERVAL_MS * (VLM_FRAME_COUNT + 3));
        while (frameRing.length && frameRing[0].t < cutoff) frameRing.shift();
    }

    // ============================================================
    // AI 核验弹窗（打卡前最后一道闸）：弹窗 + 暂停检测 + 送大模型 + 展示结果
    // ============================================================
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function renderLmFrames(frames) {
        if (!el.lmFrames) return;
        el.lmFrames.innerHTML = '';
        if (!settings.showLivenessFrames) {
            el.lmFrames.style.display = 'none';
            return;
        }
        el.lmFrames.style.display = '';
        (frames || []).forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            el.lmFrames.appendChild(img);
        });
    }

    /** 打开「正在送 AI 核验」弹窗（loading 态）。 */
    function openLivenessModal(frames) {
        if (!el.livenessModal) return;
        renderLmFrames(frames);
        el.lmCard.classList.remove('ok', 'bad', 'warn');
        el.lmBadge.innerHTML = icon('cpu');
        el.lmBar.className = 'indet';            // 不确定进度：滑块来回动
        el.lmBar.style.width = '';
        el.lmTitle.textContent = I18N.t('vlm_modal_sending');
        el.lmSub.textContent = I18N.t('vlm_modal_wait');
        el.livenessModal.classList.add('show');
    }

    /** 展示核验结果：kind = 'real' | 'fake' | 'unavailable' | 'error'。 */
    function showLivenessResult(kind, v) {
        if (!el.livenessModal) return;
        el.lmBar.className = '';                  // 停掉 loading 动画
        el.lmBar.style.width = '100%';
        el.lmCard.classList.remove('ok', 'bad', 'warn');
        const reason = v && v.reason ? v.reason : '';
        if (kind === 'real') {
            el.lmCard.classList.add('ok');
            el.lmBadge.innerHTML = icon('check-circle');
            el.lmTitle.textContent = I18N.t('vlm_modal_real', { p: Math.round(v.confidence * 100) });
            el.lmSub.textContent = reason;
        } else if (kind === 'fake') {
            el.lmCard.classList.add('bad');
            el.lmBadge.innerHTML = icon('x-circle');
            el.lmTitle.textContent = I18N.t('vlm_modal_fake', { p: Math.round(v.confidence * 100) });
            el.lmSub.textContent = reason;
        } else {                                  // unavailable / error → fail-open
            el.lmCard.classList.add('warn');
            el.lmBadge.innerHTML = icon('alert');
            el.lmTitle.textContent = I18N.t(kind === 'unavailable' ? 'vlm_modal_unavailable' : 'vlm_modal_error');
            el.lmSub.textContent = '';
        }
    }

    function closeLivenessModal() {
        if (!el.livenessModal) return;
        el.livenessModal.classList.remove('show');
        el.lmBar.className = '';
        el.lmBar.style.width = '';
    }

    /**
     * 打卡前的 AI 核验闸（异步、fire-and-forget）：
     *   暂停检测 → 弹窗 loading → 送 N 帧给大模型 → 真人则打卡、伪造则拒、不可达则放行 → 关窗恢复检测。
     * epoch 守卫：若核验期间摄像头被关/切走（clockEpoch 变了），回调一律不再打卡/不动 UI。
     */
    async function startLivenessGate(emp, action, frames, box, track) {
        const epoch = clockEpoch;
        const alive = () => epoch === clockEpoch;   // 仍是发起核验时的那次会话
        gating = true;
        // 调用方（hold 满那刻）已保证 frames 满 VLM_FRAME_COUNT 张真帧，这里不再兜底补抓，杜绝送少于 N 张。
        // 万一仍为空（极端退化）→ 下方走 fail-open，绝不送空/不足。
        openLivenessModal(frames);   // 根据设置决定是否显示送审图片；frames 仍会照常发送给 AI
        stopCameraStream();          // 关摄像头：核验期间不占相机、省资源 + 隐私（LED 灭）
        const kb = (frames && frames.length) ? Math.round(frames.reduce((a, f) => a + f.length, 0) / 1024) : 0;
        console.log('TMS VLM send:', { frames: frames ? frames.length : 0, approxKB: kb, maxEdge: VLM_FRAME_MAXEDGE, quality: VLM_FRAME_QUALITY });
        try {
            const eng = await ensureLiveness();
            if (!alive()) return;
            // 不可达 / 无客户端 / 无帧可送 → fail-open：照常打卡 + 提示核验不可用
            if (!eng || !eng.ready || !frames || !frames.length) {
                await doClock(emp, action, box, frames, track && track.data ? track.data.geometryResult : null);
                if (alive()) { showLivenessResult('unavailable', null); await sleep(1400); }
                return;
            }
            const v = await eng.verify(frames);
            if (!alive()) return;
            if (track) track.data.realProb = v.confidence;   // 供关窗后人脸框读数展示
            console.log('TMS VLM verdict:', { real: v.real, confidence: Number(v.confidence.toFixed(2)), reason: v.reason });
            if (v.real && v.confidence >= settings.livenessRealProb && !v.uncertain) {
                await doClock(emp, action, box, frames, track && track.data ? track.data.geometryResult : null, v);    // 真人 → 打卡（撒花/语音/冷却）
                if (alive()) { showLivenessResult('real', v); await sleep(1200); }
            } else {
                showLivenessResult('fake', v);               // 伪造 → 不打卡
                await sleep(2500);
                if (alive() && track) {                      // 重置该 track，让用户可重新对准重试
                    resetTrackLock(track.data, performance.now());
                }
            }
        } catch (e) {
            // 核验异常（超时/解析失败）→ fail-open：照常打卡，记录原因
            console.warn('TMS VLM gate error, fail-open:', e.message);
            if (alive()) {
                await doClock(emp, action, box, frames, track && track.data ? track.data.geometryResult : null);
                showLivenessResult('error', null);
                await sleep(1400);
            }
        } finally {
            // 只有发起核验的那次会话负责收尾，避免踩到已经开始的新一轮。
            // 先关窗 + 放开 gating，再重开摄像头：getUserMedia 无超时，若放在 await 之后会把弹窗/gating 卡死成死机。
            // 检测循环靠 readyState 自我节流，流回来前不会空跑，先放开 gating 是安全的。
            if (alive()) {
                closeLivenessModal();
                gating = false;
                try { await restartCameraStream(); }
                catch (e) { console.warn('camera restart failed', e.message); toast(I18N.t('camera_error', { msg: e.message }), 'err'); }
            }
        }
    }

    /** 把活体阶段名映射到 i18n key（提示文案）。 */
    function livenessPhaseKey(phase) {
        switch (phase) {
            case 'verifying': return 'liveness_verifying';
            default: return null;
        }
    }

    async function reloadMatcher() {
        const employees = await tmsDB.getAllEmployees();
        matcher = new FaceMatcher({ matchThreshold: settings.matchThreshold, useMeanDescriptor: true });
        matcher.loadFromData(employees.map(e => ({
            id: e.id,
            name: e.name,
            descriptors: e.descriptors,
            meanDescriptor: e.meanDescriptor
        })));
        empPhotos = new Map(employees.map(e => [e.id, e.photo]));
        // 清理已删除员工残留的冷却记录，避免随增删循环无限增长
        // （hold 状态现在挂在 track 上，随人脸离开自动淘汰，无需在此清理）
        for (const id of [...cooldown.keys()]) if (!empPhotos.has(id)) cooldown.delete(id);
        for (const id of [...weakMatchWarnedAt.keys()]) if (!empPhotos.has(id)) weakMatchWarnedAt.delete(id);
        el.empCountPill.textContent = I18N.t('emp_count', { n: employees.length });
        return employees;
    }

    // ============================================================
    // 摄像头
    // ============================================================
    const CAM_CONSTRAINTS = {
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
    };

    /** 等视频元素拿到尺寸并开始播放（带超时，避免永久挂起）。 */
    function waitVideoReady(videoEl) {
        return new Promise((resolve, reject) => {
            const tid = setTimeout(() => reject(new Error('camera metadata timeout')), 5000);
            videoEl.onerror = (e) => { clearTimeout(tid); reject(e); };
            videoEl.onloadedmetadata = () => { clearTimeout(tid); videoEl.play(); resolve(); };
        });
    }

    async function startCamera(videoEl) {
        if (stream) stopCamera();
        stream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
        activeVideo = videoEl;
        videoEl.srcObject = stream;
        await waitVideoReady(videoEl);
    }

    // 仅关摄像头硬件（核验期间省资源 + 隐私：LED 灭，表示"在核验、不在看你"）。
    // 与 stopCamera 区分：保留 activeVideo / loop / clockEpoch，核验完再 restart 续上同一会话。
    function stopCameraStream() {
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (activeVideo) activeVideo.srcObject = null;
    }

    /** 核验后重开摄像头。注意 getUserMedia 是无超时 await：期间可能被 stopCamera 拆掉，故 await 后须复检。 */
    async function restartCameraStream() {
        if (!activeVideo) return false;
        const s = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
        if (!activeVideo) {                       // await 期间被切走/拆除 → 别让新流变孤儿（LED 长亮无主）
            s.getTracks().forEach(t => t.stop());
            return false;
        }
        stream = s;
        activeVideo.srcObject = stream;
        await waitVideoReady(activeVideo);
        // 重开后清掉冻结的 track / 旧缓冲：旧 startTs 会在第一帧"秒触发"再核验，旧帧会喂错核验
        tracker.clear();
        lastClockDets = [];
        lastClockKey = null;
        lastPrimaryId = null;
        frameRing = [];
        lastFrameCapAt = 0;
        return true;
    }

    function stopCamera() {
        detecting = false;
        if (loopHandle) { cancelAnimationFrame(loopHandle); loopHandle = null; }
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (activeVideo) { activeVideo.srcObject = null; activeVideo = null; }
        // 清空逐帧的临时状态，避免下次开摄像头时：
        //  - 用旧坐标画出残影框（overlay 尺寸可能已变）
        //  - 冻结的 track（旧 startTs）在回到打卡页第一帧就「秒打卡」并绕过活体
        tracker.clear();
        lastClockDets = [];
        particles = [];
        lastClockKey = null;
        lastPrimaryId = null;
        // 清空滚动缓冲：上一场打卡的旧画面绝不能喂给下一场的活体核验
        frameRing = [];
        lastFrameCapAt = 0;
        // 解除可能正卡在 AI 核验里的暂停 + 关弹窗；clockEpoch++ 让在途核验回调失效，
        // 否则人离开后核验返回还会误打卡、且 gating 残留 true 会让下次进页检测永不恢复。
        clockEpoch++;
        gating = false;
        closeLivenessModal();
    }

    // ============================================================
    // 统一检测循环（按 appMode 分流）
    // ============================================================
    function startLoop(overlay) {
        if (loopHandle) { cancelAnimationFrame(loopHandle); loopHandle = null; }   // 防止两条循环并存
        const ctx = overlay ? overlay.getContext('2d') : null;
        detecting = true;
        let busy = false;
        let lastRun = 0;

        // clock 模式检测更快（120ms）以提升识别和倒计时反馈；enroll 模式 200ms 省电。
        // VLM 核验在采集/请求阶段异步进行（全局单飞），不阻塞检测帧率。
        const interval = appMode === 'clock' ? 120 : 200;

        const loop = async (ts) => {
            if (!detecting || !activeVideo) return;

            // 逐帧重绘 clock 叠加层，让倒计时环平滑动画（即使检测被节流）
            if (ctx && appMode === 'clock') drawClockOverlay(ctx, overlay);

            // gating 期间（AI 核验弹窗）暂停人脸检测：纯等待结果，不空跑 detectAllFaces 省资源。
            // 仍走 requestAnimationFrame 保持叠加层/粒子动画，结果回来即恢复。
            if (!busy && !gating && ts - lastRun > interval && activeVideo.readyState === activeVideo.HAVE_ENOUGH_DATA) {
                busy = true; lastRun = ts;
                try {
                    if (appMode === 'clock') {
                        // 多人：一次检测画面中所有人脸
                        const dets = await faceapi
                            .detectAllFaces(activeVideo, detectorOptions())
                            .withFaceLandmarks()
                            .withFaceDescriptors();
                        await handleClockFrameMulti(dets || []);   // await：避免 busy 提前释放导致重入/重复打卡
                    } else if (appMode === 'enroll') {
                        // 注册仍只取单张脸
                        const det = await faceapi
                            .detectSingleFace(activeVideo, detectorOptions())
                            .withFaceLandmarks()
                            .withFaceDescriptor();
                        if (ctx) drawBox(ctx, overlay, det);
                        if (det) handleEnrollFrame(det);
                    }
                } catch (e) {
                    // 单帧失败忽略，继续下一帧
                } finally {
                    busy = false;
                }
            }
            loopHandle = requestAnimationFrame(loop);
        };
        loopHandle = requestAnimationFrame(loop);
    }

    // enroll 叠加层：画人脸框（canvas 未镜像，需翻转 x 对齐镜像视频）
    function drawBox(ctx, overlay, det) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (!det) return;
        const b = det.detection.box;
        const x = mirrorX(overlay.width, b.x, b.width);
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, b.y, b.width, b.height);
    }

    // ---------- clock 实时叠加层：人脸框 + 姓名 + 倒计时环 + 提示 ----------
    // ---------- 打卡成功庆祝粒子 ----------
    function spawnCelebration(cx, cy, type) {
        if (particles.length > 320) return;   // 多人同时打卡时给粒子数封顶
        const palette = type === 'in'
            ? [COLORS.in, COLORS.celebrateIn, COLORS.accent, COLORS.celebrateLime]
            : [COLORS.out, COLORS.celebrateOut, COLORS.accent, COLORS.warn];
        for (let i = 0; i < 40; i++) {
            const ang = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 6;
            particles.push({
                x: cx, y: cy,
                vx: Math.cos(ang) * speed,
                vy: Math.sin(ang) * speed - 2,   // 略向上
                life: 1,
                size: 2 + Math.random() * 4,
                color: palette[(Math.random() * palette.length) | 0]
            });
        }
    }

    function drawParticles(ctx) {
        if (!particles.length) return;
        particles = particles.filter(p => p.life > 0);
        for (const p of particles) {
            p.vy += 0.22;            // 重力
            p.x += p.vx; p.y += p.vy;
            p.life -= 0.022;
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0, p.size * p.life), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawClockOverlay(ctx, overlay) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        drawParticles(ctx);          // 粒子始终绘制（即使人脸已离开）
        for (const item of lastClockDets) {
            drawFace(ctx, overlay, item.box, item.match, item.hold);
        }
    }

    // 画单张脸：人脸框 +（若已识别）姓名标签 + 倒计时环 + 提示
    // hs 为该脸对应 track 的 .data（hold/活体/倒计时），未识别时为 null
    function drawFace(ctx, overlay, b, match, hs) {
        const x = mirrorX(overlay.width, b.x, b.width);   // 翻转 x 对齐镜像视频
        const y = b.y;

        const done = hs && hs.phase === 'done';
        const color = !match ? COLORS.unmatched                // 未识别：灰
            : done ? COLORS.in
                : (hs && hs.phase === 'framing') ? COLORS.warn
                : (hs && hs.action === 'in' ? COLORS.in : COLORS.out);

        // 人脸框
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, b.width, b.height);

        if (!match) return;          // 未识别的脸只画灰框

        // 姓名标签（canvas 未镜像，文字可正常阅读）
        const label = match.emp.name;
        ctx.font = '600 18px -apple-system, "PingFang SC", sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = COLORS.overlayPanel;
        ctx.fillRect(x, y - 30, tw + 16, 26);
        ctx.fillStyle = COLORS.overlayText;
        ctx.fillText(label, x + 8, y - 11);

        if (!hs) return;

        // 倒计时环（人脸右上角）
        const cx = x + b.width + 4, cy = y + 18, rad = 16;
        let prog = 0, hint = '';
        if (hs.phase === 'done') { prog = 1; }
        else if (hs.phase === 'verifying') { prog = 1; hint = I18N.t('liveness_verifying'); }
        else if (hs.phase === 'framing') { prog = 0; hint = I18N.t(hs.framingKey || 'face_frame_center'); }
        else if (hs.phase === 'capturing') {
            const doneCount = Array.isArray(hs.captureFrames) ? hs.captureFrames.length : 0;
            prog = Math.min(1, doneCount / VLM_FRAME_COUNT);
            hint = I18N.t('capture_progress', { done: doneCount, total: VLM_FRAME_COUNT });
        }
        else {
            prog = Math.min(1, (performance.now() - hs.startTs) / HOLD_MS);
            hint = I18N.t(hs.action === 'in' ? 'clock_in_btn' : 'clock_out_btn');
        }
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.strokeStyle = COLORS.overlayTrack; ctx.lineWidth = 4; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
        if (hs.phase === 'done') {
            // 矢量对勾（替代 emoji ✓ 字形），在倒计时环中心描边
            ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(cx - 6, cy);
            ctx.lineTo(cx - 2, cy + 4);
            ctx.lineTo(cx + 6, cy - 5);
            ctx.stroke();
        }

        // 底部提示
        if (hint) {
            ctx.font = '600 15px -apple-system, sans-serif';
            const hw = ctx.measureText(hint).width;
            ctx.fillStyle = COLORS.overlayPanel;
            ctx.fillRect(x, y + b.height + 6, hw + 16, 24);
            ctx.fillStyle = color;
            ctx.fillText(hint, x + 8, y + b.height + 23);
        }

        // 读数：VLM 给出的真人置信度（核验完成后展示），低于阈值染警示色。
        if (hs.realProb != null) {
            const txt = 'live ' + hs.realProb.toFixed(2);
            ctx.font = '600 13px -apple-system, sans-serif';
            const rw = ctx.measureText(txt).width;
            ctx.fillStyle = COLORS.overlayPanel;
            ctx.fillRect(x, y - 30 - 22, rw + 14, 20);
            ctx.fillStyle = (hs.realProb < settings.livenessRealProb) ? COLORS.warn : COLORS.in;
            ctx.fillText(txt, x + 7, y - 30 - 7);
        }
    }

    // ============================================================
    // 打卡识别（多人同时）
    // ============================================================
    function assessFaceFraming(box, frameW, frameH) {
        if (!box || !frameW || !frameH) return { ok: false, key: 'face_frame_center' };
        const heightRatio = box.height / frameH;
        const areaRatio = (box.width * box.height) / (frameW * frameH);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const offX = Math.abs(cx - frameW / 2) / frameW;
        const offY = Math.abs(cy - frameH / 2) / frameH;

        if (heightRatio > FACE_FRAMING.maxHeightRatio || areaRatio > FACE_FRAMING.maxAreaRatio) {
            return { ok: false, key: 'face_frame_farther' };
        }
        if (heightRatio < FACE_FRAMING.minHeightRatio) {
            return { ok: false, key: 'face_frame_closer' };
        }
        if (offX > FACE_FRAMING.maxCenterOffsetX || offY > FACE_FRAMING.maxCenterOffsetY) {
            return { ok: false, key: 'face_frame_center' };
        }
        return { ok: true, key: '' };
    }

    function updateTrackGeometry(track, det, now) {
        if (!track || !track.data || typeof TmsGeometry === 'undefined') return null;
        const positions = det && det.landmarks && det.landmarks.positions;
        track.data.geometryBuffer = TmsGeometry.addSample(track.data.geometryBuffer || [], positions, now, {
            suspectScore: GEOMETRY_SUSPECT_THRESHOLD
        });
        track.data.geometryResult = TmsGeometry.assess(track.data.geometryBuffer, {
            suspectScore: GEOMETRY_SUSPECT_THRESHOLD
        });
        return track.data.geometryResult;
    }

    function geometryPatch(geometry) {
        const g = geometry || {};
        const score = g.score != null ? g.score : g.geometryScore;
        const suspect = g.suspect != null ? g.suspect : g.geometrySuspect;
        const reason = g.reason != null ? g.reason : g.geometryReason;
        return {
            geometryScore: Number.isFinite(Number(score)) ? Number(score) : null,
            geometrySuspect: !!suspect,
            geometryReason: reason || ''
        };
    }

    function resetTrackLock(d, now) {
        if (!d) return;
        d.empId = null;
        d.name = '';
        d.lockedEmpId = null;
        d.lockedName = '';
        d.lockStartTs = 0;
        d.lastAcceptedTs = 0;
        d.captureFrames = [];
        d.captureDone = false;
        d.captureFailedReason = '';
        d.action = null;
        d.startTs = now || performance.now();
        d.livePassed = false;
        d.phase = 'hold';
        d.framingKey = '';
        d.geometryBuffer = [];
        d.geometryResult = null;
        resetLiveness(d);
    }

    function startTrackLock(track, emp, confidence, now) {
        const d = track.data;
        d.empId = emp.id;
        d.name = emp.name;
        d.lockedEmpId = emp.id;
        d.lockedName = emp.name;
        d.lockStartTs = now;
        d.lastAcceptedTs = now;
        d.confidence = confidence;
        d.captureFrames = [];
        d.captureDone = false;
        d.captureFailedReason = '';
        d.action = null;
        d.startTs = now;
        d.livePassed = !settings.liveness;
        d.phase = 'capturing';
        d.framingKey = '';
        d.geometryBuffer = [];
        d.geometryResult = null;
        resetLiveness(d);
    }

    function warnWeakInitialMatch(result) {
        if (!result || result.status !== 'matched') return;
        const eid = result.user && result.user.id;
        const lastWarn = weakMatchWarnedAt.get(eid) || 0;
        if (Date.now() - lastWarn <= WEAK_MATCH_WARN_MS) return;
        weakMatchWarnedAt.set(eid, Date.now());
        console.warn('TMS rejected weak initial face match:', {
            employeeId: eid,
            confidence: Number(result.confidence.toFixed(1)),
            minConfidence: settings.initialMatchConfidence,
            distance: Number(result.distance.toFixed(4))
        });
    }

    function tryInitialLock(track, result, now) {
        if (!result || result.status !== 'matched' || result.confidence < settings.initialMatchConfidence) {
            warnWeakInitialMatch(result);
            return null;
        }
        startTrackLock(track, result.user, result.confidence, now);
        return result.user;
    }

    function topMatchForDescriptor(descriptor) {
        if (!matcher || typeof matcher.findTopMatches !== 'function') return null;
        const top = matcher.findTopMatches(descriptor, 1);
        return top && top.length ? top[0] : null;
    }

    function validateLockedTrack(track, det, result, now) {
        const d = track.data;
        if (!d || !d.lockedEmpId) return null;
        let candidate = null;
        if (result && result.status === 'matched' && result.user && result.user.id === d.lockedEmpId) {
            candidate = result;
        } else {
            const top = topMatchForDescriptor(det.descriptor);
            if (top && top.user && top.user.id === d.lockedEmpId) {
                candidate = {
                    status: 'matched',
                    user: top.user,
                    confidence: top.confidence,
                    distance: top.distance
                };
            }
        }
        if (!candidate || candidate.confidence < settings.lockedMatchConfidence) return null;
        d.lastAcceptedTs = now;
        d.confidence = candidate.confidence;
        return candidate.user;
    }

    function captureLockedFrame(track, now) {
        const d = track.data;
        if (!Array.isArray(d.captureFrames)) d.captureFrames = [];
        if (d.captureFrames.length >= VLM_FRAME_COUNT) {
            d.captureDone = true;
            return true;
        }
        const last = d.captureFrames[d.captureFrames.length - 1];
        if (last && now - last.t < VLM_FRAME_INTERVAL_MS) return false;
        const url = grabSendFrame();
        if (!url) {
            d.captureFailedReason = 'blank-or-unavailable-frame';
            return false;
        }
        d.captureFrames.push({ t: now, url });
        d.captureFailedReason = '';
        d.captureDone = d.captureFrames.length >= VLM_FRAME_COUNT;
        return d.captureDone;
    }

    async function handleClockFrameMulti(dets) {
        const now = performance.now();
        captureRingFrame(now);   // 兼容维护一份短全局缓冲；打卡送审以 track.captureFrames 为准
        // 1) 把本帧人脸框关联到稳定 track（result[i] ↔ dets[i]）
        const boxes = dets.map(d => d.detection.box);
        const tracks = tracker.update(boxes, now);

        const drawList = [];
        const matchedFaces = [];       // { track, emp, confidence, box }，用于挑选侧边卡片
        let justClocked = null;        // 本帧刚打卡成功者，卡片优先展示其 ✓
        const clockedThisFrame = new Set();  // 本帧已写库的 empId，挡同帧两张脸重复写

        for (let i = 0; i < dets.length; i++) {
            const det = dets[i];
            const track = tracks[i];
            const box = det.detection.box;
            const result = matcher ? matcher.findBestMatch(det.descriptor) : { status: 'unknown' };
            const d = track.data;

            if (!d.lockedEmpId) {
                const locked = tryInitialLock(track, result, now);
                if (!locked) {
                    resetTrackLock(d, now);
                    drawList.push({ box, match: null, hold: null });
                    continue;
                }
            }

            const emp = validateLockedTrack(track, det, result, now);
            if (!emp) {
                resetTrackLock(d, now);
                drawList.push({ box, match: null, hold: null });
                continue;
            }

            updateTrackGeometry(track, det, now);

            const framing = assessFaceFraming(box, activeVideo.videoWidth, activeVideo.videoHeight);
            if (!framing.ok) {
                d.phase = 'framing';
                d.framingKey = framing.key;
                d.livePassed = false;
                d.startTs = now;
                resetLiveness(d);
                drawList.push({ box, match: { emp, confidence: d.confidence }, hold: d });
                matchedFaces.push({ track, emp, confidence: d.confidence, box });
                continue;
            }
            d.framingKey = '';

            if (d.phase !== 'done' && d.phase !== 'verifying') d.phase = 'capturing';

            drawList.push({ box, match: { emp, confidence: d.confidence }, hold: d });
            matchedFaces.push({ track, emp, confidence: d.confidence, box });

            // 冷却中：该员工刚打过卡 → 这张脸保持 done 展示 ✓（哪怕是另一张脸/另一个 track）
            const last = cooldown.get(emp.id);
            if (last && Date.now() - last < settings.clockCooldownMs) {
                d.phase = 'done'; d.livePassed = true;
                if (d.action == null) d.action = 'in';
                continue;
            }
            // 这张脸已完成本轮打卡；冷却刚到期 → 重置状态，下帧开启新一轮
            if (d.phase === 'done') {
                resetTrackLock(d, now);
                continue;
            }

            // 首次：决定本次是上班还是下班
            if (d.action == null) {
                const lastRec = await tmsDB.getLastAttendance(emp.id);
                d.action = lastRec && lastRec.type === 'in' ? 'out' : 'in';
                d.startTs = now;
            }

            // 锁定后按该 track 的时间线抓满 VLM_FRAME_COUNT 张；抓满才写记录或送实时 AI。
            d.livePassed = true;
            const captureDone = captureLockedFrame(track, now);

            // 每个 track 自己攒满 3 张（每张至少间隔 1 秒）后才允许写记录。
            if (captureDone) {
                // 同帧/冷却双重去重：同一员工被两张脸同时拍到时只触发一次
                const c = cooldown.get(emp.id);
                const inCooldown = c && Date.now() - c < settings.clockCooldownMs;
                if (inCooldown || clockedThisFrame.has(emp.id)) { d.phase = 'done'; continue; }
                const captured = d.captureFrames.map(f => f.url).filter(Boolean);
                if (captured.length < VLM_FRAME_COUNT) { d.phase = 'capturing'; continue; }

                // 实时核验模式：阻塞送审（打卡时弹窗等 AI，慢但当场拦截）
                if (settings.liveness && settings.livenessMode === 'realtime') {
                    // 已有一次核验在进行（同帧另一张脸刚触发）→ 本帧此脸不再触发
                    if (gating) { d.phase = 'verifying'; continue; }
                    clockedThisFrame.add(emp.id);
                    d.phase = 'verifying';
                    startLivenessGate(emp, d.action, captured, box, track);   // fire-and-forget；gating 接管
                    continue;
                }

                // 先打卡后核验（deferred）/ 关闭防伪：立即打卡，不阻塞。
                // 所有记录都保存抓拍帧用于记录预览；仅开启 AI 时才标记 pending 进入批量核验。
                d.phase = 'verifying';
                d.phase = 'done';
                clockedThisFrame.add(emp.id);
                if (await doClock(emp, d.action, box, captured, d.geometryResult)) {
                    justClocked = matchedFaces[matchedFaces.length - 1];
                } else {
                    // 写库失败 → 保留锁定状态，下帧继续尝试写这 3 张抓拍
                    d.phase = 'capturing'; d.startTs = now;
                }
            }
        }

        lastClockDets = drawList;
        // 过期 track 由 tracker 自身淘汰，无需手动清理

        // 侧边卡片：优先刚打卡成功者；否则保持上一个 primary（仍在画面时）或最大的脸
        //（迟滞：仅当别的脸明显更大 >1.3x 才切换，避免两张相近大小的脸来回抖动）
        let target = justClocked || null;
        if (!target && matchedFaces.length) {
            const sticky = matchedFaces.find(f => f.emp.id === lastPrimaryId);
            const biggest = matchedFaces.reduce((a, b) => (b.box.width * b.box.height > a.box.width * a.box.height ? b : a));
            target = (sticky && biggest.box.width * biggest.box.height < sticky.box.width * sticky.box.height * 1.3) ? sticky : biggest;
        }

        if (target) {
            lastPrimaryId = target.emp.id;
            const d = target.track.data;
            const phase = d.phase === 'done' ? 'done' : (d.phase === 'verifying' ? 'verifying' : (d.phase === 'framing' ? 'framing' : (d.phase === 'capturing' ? 'capturing' : 'holding')));
            renderClockStatus(target.emp, target.confidence, phase, d);
        } else if (dets.length) {
            lastPrimaryId = null;
            showClockNoMatch();
        } else {
            lastPrimaryId = null;
            showClockIdle();
        }
    }

    function renderClockStatus(emp, confidence, phase, hs) {
        const captureCount = hs && Array.isArray(hs.captureFrames) ? hs.captureFrames.length : 0;
        const key = emp.id + ':' + phase + ':' + captureCount + ':' + (hs && hs.framingKey ? hs.framingKey : '');
        if (key === lastClockKey) return;
        lastClockKey = key;

        const initial = (emp.name || '?').charAt(0).toUpperCase();
        const photo = empPhotos.get(emp.id);
        const action = hs ? hs.action : 'in';
        const cls = phase === 'done' ? 'ok' : (action === 'in' ? 'in' : 'out');

        let sub;
        if (phase === 'done') sub = I18N.t('clock_recorded', { c: confidence.toFixed(0) });
        else if (livenessPhaseKey(phase)) sub = I18N.t(livenessPhaseKey(phase));
        else if (phase === 'framing') sub = I18N.t((hs && hs.framingKey) || 'face_frame_center');
        else if (phase === 'capturing') {
            sub = I18N.t('capture_progress', { done: captureCount, total: VLM_FRAME_COUNT });
        }
        else sub = I18N.t(action === 'in' ? 'hold_to_in' : 'hold_to_out');

        el.clockCard.innerHTML = '';
        el.clockCard.append(buildAvatar(initial, cls, photo), buildText(emp.name, sub));
        if (phase === 'done') {
            const badge = document.createElement('div');
            badge.className = 'clock-badge ok';
            badge.innerHTML = icon('check');
            const bt = document.createElement('span');
            bt.textContent = I18N.t('clock_done');
            badge.appendChild(bt);
            el.clockCard.appendChild(badge);
        }
        el.clockCard.className = 'clock-card show';
        el.clockHint.textContent = '';
    }

    function buildAvatar(initial, cls, photo, baseClass = 'clock-avatar') {
        const a = document.createElement('div');
        a.className = cls ? baseClass + ' ' + cls : baseClass;
        if (photo) {
            const img = document.createElement('img');
            img.src = photo;          // dataURL，.src 赋值不会执行脚本
            a.appendChild(img);
        } else {
            a.textContent = initial;
        }
        return a;
    }
    function buildText(name, sub) {
        const wrap = document.createElement('div');
        wrap.className = 'clock-meta';
        const n = document.createElement('div'); n.className = 'clock-name'; n.textContent = name;
        const s = document.createElement('div'); s.className = 'clock-sub'; s.textContent = sub;
        wrap.append(n, s);
        return wrap;
    }

    // 根据排班计算打卡状态：迟到 / 早退 / 加班 / 正常
    function parseHM(s) { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }
    function computeStatus(type, ts) {
        const d = new Date(ts);
        const mins = d.getHours() * 60 + d.getMinutes();
        const start = parseHM(settings.workStart);
        const end = parseHM(settings.workEnd);
        if (type === 'in') return mins > start + (settings.graceMin || 0) ? 'late' : 'ontime';
        // out
        if (mins < end) return 'early';
        if (mins > end + 30) return 'overtime';
        return 'ontime';
    }

    async function doClock(emp, type, box, frames, geometry, vlmVerdict) {
        lastClockKey = null;
        const status = computeStatus(type, Date.now());
        // 抓拍帧用于记录预览；只有延迟 AI 核验开启时才标记 pending，待 HR 事后批量送 AI。
        const hasFrames = Array.isArray(frames) && frames.length > 0;
        const needsDeferredVerify = hasFrames && settings.liveness && settings.livenessMode !== 'realtime';
        const gp = geometryPatch(geometry);
        const geometryNeedsReview = settings.liveness && gp.geometrySuspect;
        const vp = vlmVerdict ? {
            verifyConfidence: vlmVerdict.confidence,
            verifyReason: vlmVerdict.reason || '',
            verifyAttackType: vlmVerdict.attack_type || 'unknown',
            verifySpoofCues: Array.isArray(vlmVerdict.spoof_cues) ? vlmVerdict.spoof_cues : [],
            verifyUncertain: !!vlmVerdict.uncertain,
            verifyVersion: (typeof TmsLiveness !== 'undefined' && TmsLiveness.VLM_PROMPT_VERSION) || 'unknown',
            verifiedAt: Date.now()
        } : {};
        // handleClockFrameMulti 是被 await 的，这里不会并发重入；
        // 写库成功后再置冷却 + 反馈，写失败则回退该员工的 hold 让其可重试。
        let saved;
        try {
            saved = await tmsDB.addAttendance({
                employeeId: emp.id, employeeName: emp.name, type, status,
                verifyStatus: needsDeferredVerify ? 'pending' : (geometryNeedsReview ? 'suspect' : (vlmVerdict ? 'real' : 'none')),
                ...gp,
                ...vp
            });
        } catch (e) {
            // 写库失败：返回 false，由调用方回退该 track 的 hold 让其重试（不影响其他人）
            toast(I18N.t('clock_fail', { msg: e.message }), 'err');
            return false;
        }
        // 帧存独立 store（失败不影响打卡本身，只是该条无法被核验）
        if (hasFrames) {
            try { await tmsDB.saveFrames(saved.recordId, frames); }
            catch (e) { console.warn('TMS: saveFrames failed', e.message); }
        }
        cooldown.set(emp.id, Date.now());
        // 从这张脸的位置迸发庆祝粒子（坐标翻转对齐镜像视频）
        if (box && el.clockOverlay) {
            spawnCelebration(mirrorX(el.clockOverlay.width, box.x, box.width / 2), box.y + box.height / 2, type);
        }
        beep(type === 'in' ? 880 : 520);
        speak(I18N.t(type === 'in' ? 'voice_in' : 'voice_out', { name: emp.name }));
        toast(I18N.t(type === 'in' ? 'toast_clock_in' : 'toast_clock_out', { name: emp.name }), 'ok');
        // 只有当记录/看板页正在显示时才即时刷新，避免在打卡热路径上做整库 getAll + 重建 DOM 造成卡顿；
        // 切到这些标签时 switchTab 会自行刷新。
        if (document.getElementById('panel-records').classList.contains('show')) renderRecords();
        if (document.getElementById('panel-dashboard').classList.contains('show')) renderDashboard();
        return true;
    }

    // ---------- 声音 / 语音 ----------
    // soundEnabled 是总控：提示音(beep) + 语音(speak) 一起受它约束。
    // speakEnabled 是子项：仅控制语音播报，且必须 soundEnabled 才生效。
    let audioCtx = null;
    function beep(freq) {
        try {
            if (!settings.soundEnabled) return;
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.frequency.value = freq; o.type = 'sine';
            o.connect(g); g.connect(audioCtx.destination);
            g.gain.setValueAtTime(0.18, audioCtx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
            o.start(); o.stop(audioCtx.currentTime + 0.25);
        } catch (e) {}
    }

    // 按 UI 语言读/写选定的 voiceURI。兼容旧版的扁平字符串（迁移期：旧值同时套用到两种语言）。
    function voiceURIFor(lang) {
        const v = settings.speakVoiceURI;
        if (v && typeof v === 'object') return v[lang] || '';
        return typeof v === 'string' ? v : '';
    }
    function setVoiceURIFor(lang, uri) {
        const cur = settings.speakVoiceURI;
        const next = (cur && typeof cur === 'object') ? { ...cur } : { en: '', zh: '' };
        next[lang] = uri;
        settings = tmsDB.saveSettings({ speakVoiceURI: next });
    }

    function speak(text) {
        try {
            if (!('speechSynthesis' in window)) return;
            if (!settings.soundEnabled || !settings.speakEnabled) return;
            const u = new SpeechSynthesisUtterance(text);
            const saved = voiceURIFor(I18N.lang);
            const voice = saved ? speechSynthesis.getVoices().find(v => v.voiceURI === saved) : null;
            if (voice) {
                u.voice = voice;
                u.lang = voice.lang;
            } else {
                // 没选/选过的语音在本设备不存在 → 回退浏览器默认，按当前 UI 语言对齐
                u.lang = I18N.lang === 'zh' ? 'zh-CN' : 'en-US';
            }
            u.rate = 1.0;
            speechSynthesis.cancel();
            speechSynthesis.speak(u);
        } catch (e) {}
    }

    // 下拉只列当前 UI 语言的语音（避免中/英混用导致发音不匹配）；
    // 该语言无可用语音时回退列出全部，避免空下拉。选中项取当前语言已存的 voiceURI。
    function populateVoiceSelect() {
        if (!el.voiceSelect || !('speechSynthesis' in window)) return;
        const all = speechSynthesis.getVoices();
        if (!all.length) return;
        const prefix = I18N.lang === 'zh' ? 'zh' : 'en';
        let voices = all.filter(v => (v.lang || '').toLowerCase().startsWith(prefix));
        if (!voices.length) voices = all;
        const saved = voiceURIFor(I18N.lang);
        el.voiceSelect.innerHTML =
            `<option value="">${I18N.t('voice_default')}</option>` +
            voices.map(v =>
                `<option value="${v.voiceURI}"${v.voiceURI === saved ? ' selected' : ''}>${v.name} (${v.lang})</option>`
            ).join('');
    }

    function showClockIdle() {
        if (lastClockKey === '__idle__') return;
        lastClockKey = '__idle__';
        el.clockCard.className = 'clock-card';
        el.clockHint.textContent = matcher && matcher.getUserCount() > 0
            ? I18N.t('clock_face_camera') : I18N.t('clock_no_employees');
    }
    function showClockNoMatch() {
        if (lastClockKey === '__nomatch__') return;
        lastClockKey = '__nomatch__';
        el.clockCard.className = 'clock-card';
        el.clockHint.textContent = I18N.t('clock_no_match');
    }

    // ============================================================
    // 员工注册
    // ============================================================
    let captureCanvas = null;
    function grabFrame(video) {
        if (!captureCanvas) captureCanvas = document.createElement('canvas');
        captureCanvas.width = video.videoWidth;
        captureCanvas.height = video.videoHeight;
        const c = captureCanvas.getContext('2d');
        c.drawImage(video, 0, 0);
        return c.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
    }

    function handleEnrollFrame(det) {
        const frame = grabFrame(activeVideo);
        regManager.processDetection(det, frame);
    }

    function wireRegManager() {
        regManager.onProgress = (p) => {
            el.enrollBar.style.width = p.percentage + '%';
            el.enrollText.textContent = `${p.current} / ${p.total}`;
        };
        regManager.onCapture = (data) => {
            if (data.thumbnail) {
                const img = document.createElement('img');
                img.src = data.thumbnail;
                el.enrollThumbs.appendChild(img);
            }
        };
        regManager.onComplete = async (res) => {
            const data = regManager.getRegistrationData(); // { id, name, descriptors, meanDescriptor }
            // 取采集过程中间的一帧脸部缩略图作为员工照片
            const frames = regManager.capturedFrames || [];
            const photo = frames.length ? frames[Math.floor(frames.length / 2)] : null;
            await tmsDB.saveEmployee({
                id: data.id,
                name: data.name,
                department: el.empDept.value.trim(),
                descriptors: data.descriptors,
                meanDescriptor: data.meanDescriptor,
                photo,
                capturedFrames: frames.slice(0, settings.enrollCaptures),
                enrolledAt: Date.now()
            });
            await reloadMatcher();
            await renderEmployees();
            closeEnroll();
            toast(I18N.t('enroll_success', { name: data.name }), 'ok');
        };
        regManager.onError = (e) => { toast(I18N.t('enroll_fail', { msg: e.message }), 'err'); closeEnroll(); };
    }

    async function openEnroll() {
        const name = el.empName.value.trim();
        if (!name) { toast(I18N.t('need_name'), 'err'); return; }
        const id = 'emp_' + Date.now().toString(36);

        el.enrollTitle.textContent = I18N.t('enroll_title', { name });
        el.enrollThumbs.innerHTML = '';
        el.enrollBar.style.width = '0%';
        el.enrollText.textContent = `0 / ${settings.enrollCaptures}`;
        el.enrollModal.classList.add('show');

        appMode = 'enroll';
        regManager.start(id, name);
        try {
            await startCamera(el.enrollVideo);
        } catch (e) {
            closeEnroll();
            toast(I18N.t('camera_error', { msg: e.message }), 'err');
            return;
        }
        el.enrollOverlay.width = el.enrollVideo.videoWidth;
        el.enrollOverlay.height = el.enrollVideo.videoHeight;
        startLoop(el.enrollOverlay);
    }

    function closeEnroll() {
        el.enrollModal.classList.remove('show');
        stopCamera();
        appMode = 'idle';
        if (regManager.getState() !== 'saved') regManager.cancel();
        el.empName.value = '';
        el.empDept.value = '';
    }

    async function renderEmployees() {
        const employees = await tmsDB.getAllEmployees();
        el.empList.innerHTML = '';
        el.empEmpty.style.display = employees.length ? 'none' : 'block';
        employees.forEach(emp => {
            const row = document.createElement('div');
            row.className = 'emp-row';

            const av = buildAvatar((emp.name || '?').charAt(0).toUpperCase(), '', emp.photo, 'emp-avatar');
            if (emp.photo) {
                av.classList.add('has-photo');
                av.title = I18N.t('view_registered_faces');
                av.onclick = () => openFacePreview(emp);
            }

            const info = document.createElement('div');
            info.className = 'emp-info';
            const n = document.createElement('div'); n.className = 'emp-name'; n.textContent = emp.name;
            const m = document.createElement('div'); m.className = 'emp-meta';
            m.textContent = I18N.t('emp_meta', {
                dept: emp.department || I18N.t('dash'),
                n: (emp.descriptors || []).length,
                date: new Date(emp.enrolledAt).toLocaleDateString()
            });
            info.append(n, m);

            const actions = document.createElement('div');
            actions.className = 'emp-actions';

            const preview = document.createElement('button');
            preview.className = 'emp-action';
            preview.type = 'button';
            preview.innerHTML = icon('eye');
            preview.title = I18N.t('view_registered_faces');
            preview.setAttribute('aria-label', I18N.t('view_registered_faces'));
            preview.onclick = () => openFacePreview(emp);

            const edit = document.createElement('button');
            edit.className = 'emp-action';
            edit.type = 'button';
            edit.innerHTML = icon('edit');
            edit.title = I18N.t('edit_staff');
            edit.setAttribute('aria-label', I18N.t('edit_staff'));
            edit.onclick = () => editEmployee(emp);

            const del = document.createElement('button');
            del.className = 'emp-action danger';
            del.type = 'button';
            del.innerHTML = icon('trash');
            del.title = I18N.t('delete_staff');
            del.setAttribute('aria-label', I18N.t('delete_staff'));
            del.onclick = async () => {
                const ok = await TmsModal.confirm({
                    title: I18N.t('delete_staff'),
                    body: I18N.t('emp_delete_confirm', { name: emp.name }),
                    okLabel: I18N.t('delete_staff'),
                    danger: true
                });
                if (!ok) return;
                await tmsDB.deleteEmployee(emp.id);
                await reloadMatcher();
                await renderEmployees();
                toast(I18N.t('deleted'), 'ok');
            };
            actions.append(preview, edit, del);

            row.append(av, info, actions);
            el.empList.appendChild(row);
        });
    }

    function faceFrames(emp) {
        const frames = Array.isArray(emp.capturedFrames) ? emp.capturedFrames.filter(Boolean) : [];
        if (frames.length) return frames;
        return emp.photo ? [emp.photo] : [];
    }

    async function openFacePreview(emp) {
        const frames = faceFrames(emp);
        if (!frames.length) { toast(I18N.t('no_photo'), 'err'); return; }
        const body = document.createElement('div');
        const note = document.createElement('p');
        note.className = 'modal-note';
        note.textContent = I18N.t('face_preview_note', { n: frames.length });
        const grid = document.createElement('div');
        grid.className = 'capture-grid';
        frames.forEach((src, index) => {
            const tile = document.createElement('figure');
            tile.className = 'capture-tile';
            const img = document.createElement('img');
            img.src = src;
            img.alt = I18N.t('face_sample_alt', { n: index + 1 });
            const cap = document.createElement('figcaption');
            cap.textContent = I18N.t('face_sample_label', { n: index + 1 });
            tile.append(img, cap);
            grid.appendChild(tile);
        });
        body.append(note, grid);
        await TmsModal.alert({
            title: I18N.t('faces_title', { name: emp.name || emp.id }),
            body,
            wide: true
        });
    }

    async function editEmployee(emp) {
        const values = await TmsModal.form({
            title: I18N.t('edit_staff'),
            submitLabel: I18N.t('save'),
            fields: [
                { name: 'name', label: I18N.t('label_name'), value: emp.name || '', placeholder: I18N.t('ph_name'), required: true },
                { name: 'department', label: I18N.t('label_dept'), value: emp.department || '', placeholder: I18N.t('ph_dept') }
            ],
            validate: (values) => {
                if (!values.name) {
                    toast(I18N.t('need_name'), 'err');
                    return false;
                }
                return true;
            }
        });
        if (!values) return;
        const name = values.name.trim();
        const department = values.department.trim();
        if (name === (emp.name || '') && department === (emp.department || '')) return;
        try {
            await tmsDB.updateEmployeeProfile(emp.id, { name, department });
            await reloadMatcher();
            await renderEmployees();
            lastClockKey = null;
            if (document.getElementById('panel-records').classList.contains('show')) await renderRecords();
            if (document.getElementById('panel-dashboard').classList.contains('show')) await renderDashboard();
            toast(I18N.t('staff_updated', { name }), 'ok');
        } catch (e) {
            toast(I18N.t('staff_update_fail', { msg: e.message }), 'err');
        }
    }

    // ============================================================
    // 考勤记录
    // ============================================================
    let recordsTable = null;

    function ensureRecordsTable() {
        if (recordsTable) return recordsTable;
        recordsTable = new TmsTabular.Table({
            tbody: el.recordsBody,
            empty: el.recordsEmpty,
            filterInput: el.recordsFilter,
            pageSizeSelect: el.recordsPageSize,
            prevBtn: el.recordsPrevBtn,
            nextBtn: el.recordsNextBtn,
            pageInfo: el.recordsPageInfo,
            sortButtons: document.querySelectorAll('[data-record-sort]'),
            sortKey: 'date',
            sortDir: 'desc',
            pageInfoText: ({ start, end, total, page, pages }) => I18N.t('records_page_info', { start, end, total, page, pages }),
            rowTitle: () => I18N.t('record_preview'),
            onRowClick: openReview,
            columns: recordColumns()
        });
        return recordsTable;
    }

    function recordColumns() {
        return [
            {
                key: 'employeeName',
                value: r => r.employeeName || '',
                filterValue: r => `${r.employeeName || ''} ${r.employeeId || ''}`
            },
            {
                key: 'type',
                value: r => r.type === 'in' ? I18N.t('type_in') : I18N.t('type_out'),
                sortValue: r => r.type,
                render: (r, td) => {
                    td.className = r.type === 'in' ? 'cell-in' : 'cell-out';
                    td.innerHTML = icon('dot') + ' ';
                    const span = document.createElement('span');
                    span.textContent = r.type === 'in' ? I18N.t('type_in') : I18N.t('type_out');
                    td.appendChild(span);
                }
            },
            {
                key: 'date',
                value: r => new Date(r.timestamp).toLocaleDateString(),
                sortValue: r => r.timestamp
            },
            {
                key: 'time',
                value: r => new Date(r.timestamp).toLocaleTimeString(),
                sortValue: r => r.timestamp
            },
            {
                key: 'status',
                value: r => I18N.t('status_' + (r.status || 'ontime')),
                sortValue: r => r.status || 'ontime',
                render: (r, td) => {
                    const st = r.status || 'ontime';
                    if (st !== 'ontime') {
                        const badge = document.createElement('span');
                        badge.className = 'status-badge ' + st;
                        badge.textContent = I18N.t('status_' + st);
                        td.appendChild(badge);
                    } else {
                        td.textContent = I18N.t('status_ontime');
                        td.className = 'cell-muted';
                    }
                }
            },
            {
                key: 'verifyStatus',
                value: r => verifyText(r.verifyStatus || 'none'),
                sortValue: r => r.verifyStatus || 'none',
                // 过滤值附带原始 token（pending/real/suspect/reviewed/error），
                // 既支持本地化文字搜索，也支持按 token 精确过滤（避免英文 Review⊂Reviewed 歧义）
                filterValue: r => { const vs = r.verifyStatus || 'none'; return verifyText(vs) + ' ' + vs; },
                render: (r, td) => {
                    const vs = r.verifyStatus || 'none';
                    td.className = 'verify-cell verify-' + vs;
                    td.innerHTML = verifyBadge(vs);
                    td.title = I18N.t('record_preview');
                }
            }
        ];
    }

    async function renderRecords() {
        const recs = await tmsDB.getAllAttendance();
        ensureRecordsTable().setData(recs);
        el.recordsSummary.textContent = summarizeHours(recs);
        updateFilterChips();   // 数据变了 → 刷新快捷筛选条计数 + 重试按钮可见性
    }

    function verifyText(vs) {
        const key = {
            pending: 'verify_pending',
            real: 'verify_real',
            suspect: 'verify_suspect',
            reviewed: 'verify_reviewed',
            error: 'verify_error'
        }[vs];
        return key ? I18N.t(key) : I18N.t('dash');
    }

    // 核验状态 → 图标 + 文案
    function verifyBadge(vs) {
        const map = {
            pending:  ['hourglass',    'verify_pending'],
            real:     ['check-circle', 'verify_real'],
            suspect:  ['alert',        'verify_suspect'],
            reviewed: ['user-check',   'verify_reviewed'],
            error:    ['alert',        'verify_error']
        };
        if (!map[vs]) return I18N.t('dash');   // none：未抓帧/实时模式/关防伪
        const [ic, key] = map[vs];
        return `<span class="vbadge">${icon(ic)}<span>${I18N.t(key)}</span></span>`;
    }

    // ============================================================
    // 延迟核验：HR 在记录页批量送 AI（可中断、可续跑）
    // ============================================================
    let batchRunning = false;

    // 批量核验时间范围 → 起始时间戳（含）。today=今天 00:00；week=近 7 天 00:00；all=不限。
    function verifyCutoff(scope) {
        if (scope === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
        if (scope === 'week') { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 6); return d.getTime(); }
        return -Infinity;   // all
    }

    // 进度条 + 文案 + 预计剩余。done=null → 隐藏；etaMs=null → 不显示剩余时间（首条还没数据）。
    function setVerifyProgress(done, total, etaMs) {
        if (!el.verifyProgress) return;
        if (done == null) {
            el.verifyProgress.style.display = 'none';
            if (el.verifyBar) el.verifyBar.style.width = '0%';
            if (el.verifyProgressText) el.verifyProgressText.textContent = '';
            return;
        }
        el.verifyProgress.style.display = 'block';
        const pct = total ? Math.round(done / total * 100) : 0;
        if (el.verifyBar) el.verifyBar.style.width = pct + '%';
        if (el.verifyProgressText) {
            el.verifyProgressText.textContent = (etaMs != null)
                ? I18N.t('verify_progress_eta', { done, total, eta: fmtEta(etaMs) })
                : I18N.t('verify_progress', { done, total });
        }
    }

    // 毫秒 → 简短倒计时文案：>=60s 用 "M:SS"，否则 "Ss"（语种中立）
    function fmtEta(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        const m = Math.floor(s / 60);
        return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
    }

    // onlyStatuses: 限定要处理的核验状态数组（如 ['error'] 只重跑失败）；
    // 默认处理 pending/error，并重跑旧 VLM prompt 版本的 real/suspect，避免安全规则升级后保留旧误判。
    async function runBatchVerify(onlyStatuses) {
        const explicitStatuses = Array.isArray(onlyStatuses);
        const wanted = explicitStatuses ? onlyStatuses : ['pending', 'error'];
        // 已在跑 → 点击即停（已核验的记录都已落库，停了下次继续）
        if (batchRunning) { batchRunning = false; return; }
        if (!settings.liveness) { toast(I18N.t('verify_engine_off'), 'err'); return; }

        const all = await tmsDB.getAllAttendance();
        // 时间范围：全部 / 仅今天 / 近 7 天 —— 避免每次全库扫，HR 通常只核验近期
        const cutoff = verifyCutoff(el.verifyScope ? el.verifyScope.value : 'all');
        const currentVerifyVersion = (typeof TmsLiveness !== 'undefined' && TmsLiveness.VLM_PROMPT_VERSION) || 'unknown';
        // pending=从未核验；error=上次失败可重试；默认按钮也会重跑旧 prompt 版本的 real/suspect。
        const queue = all.filter(r =>
            r.timestamp >= cutoff &&
            (wanted.includes(r.verifyStatus) ||
                (!explicitStatuses && (r.verifyStatus === 'real' || r.verifyStatus === 'suspect') && r.verifyVersion !== currentVerifyVersion)));
        if (!queue.length) { toast(I18N.t('verify_none_pending'), 'ok'); return; }

        const eng = await ensureLiveness();
        if (!eng || !eng.ready) { toast(I18N.t('verify_engine_off'), 'err'); return; }

        batchRunning = true;
        if (el.verifyRunBtn) el.verifyRunBtn.querySelector('span').textContent = I18N.t('verify_stop_btn');
        let done = 0, flagged = 0;
        // ETA 用最近 N 条耗时的滑动平均（而非全程均值），对速度突变（模型预热后变快）响应更准
        const ETA_WINDOW = 5;
        const durations = [];
        let tick = performance.now();
        for (const r of queue) {
            if (!batchRunning) break;                       // 可中断
            const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
            const eta = avg != null ? avg * (queue.length - done) : null;   // 首条无数据时不显示
            setVerifyProgress(done, queue.length, eta);
            const frames = await tmsDB.getFrames(r.recordId);
            if (!frames || !frames.length) {                // 没帧可核验 → 归为 none，不再排队
                await tmsDB.updateAttendanceVerify(r.recordId, { verifyStatus: 'none' });
                done++; continue;
            }
            try {
                const v = await eng.verify(frames);          // {real, confidence, reason}
                const geometrySuspect = !!r.geometrySuspect;
                const isReal = v.real && v.confidence >= settings.livenessRealProb && !v.uncertain && !geometrySuspect;
                const verifyPatch = {
                    verifyStatus: isReal ? 'real' : 'suspect',
                    verifyConfidence: v.confidence,
                    verifyReason: v.reason,
                    verifyAttackType: v.attack_type || 'unknown',
                    verifySpoofCues: Array.isArray(v.spoof_cues) ? v.spoof_cues : [],
                    verifyUncertain: !!v.uncertain,
                    verifyVersion: currentVerifyVersion,
                    verifiedAt: Date.now()
                };
                if (isReal) {
                    await tmsDB.updateAttendanceVerify(r.recordId, {
                        ...verifyPatch,
                        ...geometryPatch(r)
                    });
                    // 保留抓拍帧：记录表任意记录都可点开查看当时画面。
                } else {
                    await tmsDB.updateAttendanceVerify(r.recordId, {
                        ...verifyPatch,
                        ...geometryPatch(r)
                    });
                    flagged++;                               // 保留帧供 HR 复核
                }
            } catch (e) {
                // 核验失败（LM Studio 超时/不可达）→ error，保留帧，下次可重试
                await tmsDB.updateAttendanceVerify(r.recordId, { verifyStatus: 'error', verifyReason: e.message });
            }
            done++;
            // 记录本条耗时进滑动窗口（保留最近 ETA_WINDOW 条）
            const nowT = performance.now();
            durations.push(nowT - tick);
            if (durations.length > ETA_WINDOW) durations.shift();
            tick = nowT;
        }
        batchRunning = false;
        if (el.verifyRunBtn) el.verifyRunBtn.querySelector('span').textContent = I18N.t('verify_run_btn');
        setVerifyProgress(null);
        toast(I18N.t('verify_done', { done, flagged }), flagged ? 'err' : 'ok');
        await renderRecords();
        // 完成后若有疑似记录 → 自动把记录表过滤到「需复核」，HR 一键看到该处理的。
        // 用原始 token 'suspect' 精确过滤（中英都不误匹配 reviewed/已复核）。
        if (flagged > 0) applySuspectFilter();
    }

    // ---------- 失败自动重试：LM Studio 健康恢复后后台补跑 error ----------
    // 边沿触发：健康从「未知/不可达」→「可达」且存在 error 记录时，自动跑一次 ['error']。
    // 用边沿（而非每次可达都跑）避免某条帧损坏永远失败导致无限重试。
    let autoRetryTimer = null;
    let lastHealthOk = null;                 // null=未知 | true | false
    const AUTO_RETRY_INTERVAL_MS = 30000;

    function startAutoRetryPoll() {
        if (autoRetryTimer) return;
        lastHealthOk = null;
        autoRetryTimer = setInterval(autoRetryTick, AUTO_RETRY_INTERVAL_MS);
    }
    function stopAutoRetryPoll() {
        if (autoRetryTimer) { clearInterval(autoRetryTimer); autoRetryTimer = null; }
        lastHealthOk = null;
    }
    async function autoRetryTick() {
        if (!settings.autoRetry || !settings.liveness || batchRunning) return;
        const all = await tmsDB.getAllAttendance();
        if (!all.some(r => r.verifyStatus === 'error')) { lastHealthOk = null; return; }  // 无失败 → 重置边沿
        const eng = await ensureLiveness();
        let ok = false;
        if (eng) { try { ok = await eng.health(); } catch (e) { ok = false; } }   // 每次实测当前健康
        if (ok && lastHealthOk !== true) {        // 不可达/未知 → 可达 的上升沿
            toast(I18N.t('auto_retry_running'), 'ok');
            await runBatchVerify(['error']);
        }
        lastHealthOk = ok;
    }

    // 快捷筛选条：可点击过滤的「待处理」状态 + 只读展示的「已完成」状态
    const FILTER_STATUSES = ['pending', 'suspect', 'error'];        // 可点击
    const DONE_STATUSES = ['real', 'reviewed'];                     // 只读计数（灰显）
    const STATUS_ICON = { pending: 'hourglass', suspect: 'alert', error: 'x-circle', real: 'check-circle', reviewed: 'user-check' };

    // 当前搜索框是否正按某个状态 token 过滤
    function activeStatusFilter() {
        const v = el.recordsFilter ? el.recordsFilter.value.trim().toLowerCase() : '';
        return FILTER_STATUSES.includes(v) ? v : '';
    }

    // 把记录表过滤到某状态（token 精确）；空字符串=清除。批量完成后过滤到 suspect 即调用它。
    function setStatusFilter(token) {
        if (el.recordsFilter) {
            el.recordsFilter.value = token || '';
            el.recordsFilter.dispatchEvent(new Event('input'));   // 触发 TmsTabular 过滤 + updateFilterChips
        }
        updateFilterChips();
    }
    function applySuspectFilter() { setStatusFilter('suspect'); }

    // 多状态快捷筛选条：待核验 N / 需复核 N / 失败 N，点击切换；并同步「重试失败」按钮可见性。
    function updateFilterChips() {
        if (!el.recordsFilterChip) return;
        const data = recordsTable ? recordsTable.data : [];
        const counts = { pending: 0, suspect: 0, error: 0, real: 0, reviewed: 0 };
        data.forEach(r => { const s = r.verifyStatus || 'none'; if (s in counts) counts[s]++; });
        const active = activeStatusFilter();
        const cats = FILTER_STATUSES.filter(k => counts[k] > 0);
        const doneCats = DONE_STATUSES.filter(k => counts[k] > 0);

        // 「重试失败」按钮：仅有失败记录时显示，带计数
        if (el.verifyRetryBtn) {
            el.verifyRetryBtn.style.display = counts.error > 0 ? 'inline-flex' : 'none';
            const span = el.verifyRetryBtn.querySelector('span');
            if (span) span.textContent = I18N.t('verify_retry_btn', { n: counts.error });
        }

        if (!cats.length && !doneCats.length) { el.recordsFilterChip.style.display = 'none'; el.recordsFilterChip.innerHTML = ''; return; }
        el.recordsFilterChip.style.display = 'flex';
        let html = cats.map(k =>
            `<button type="button" class="fchip verify-${k}${active === k ? ' active' : ''}" data-fstatus="${k}">` +
            `${icon(STATUS_ICON[k])}<span>${verifyText(k)} · ${counts[k]}</span></button>`
        ).join('');
        if (active) html += `<button type="button" class="fchip fchip-clear" data-fclear="1">${icon('x-circle')}<span>${I18N.t('filter_clear')}</span></button>`;
        // 已完成状态：只读计数，灰显不可点（让 HR 也看到「已处理多少」）
        html += doneCats.map(k =>
            `<span class="fchip fchip-done verify-${k}">${icon(STATUS_ICON[k])}<span>${verifyText(k)} · ${counts[k]}</span></span>`
        ).join('');
        el.recordsFilterChip.innerHTML = html;
        el.recordsFilterChip.querySelectorAll('[data-fstatus]').forEach(b => {
            b.onclick = () => { const k = b.dataset.fstatus; setStatusFilter(active === k ? '' : k); };  // 再点同一个=取消
        });
        const clr = el.recordsFilterChip.querySelector('[data-fclear]');
        if (clr) clr.onclick = () => setStatusFilter('');
    }

    // ---------- 人工复核弹窗 ----------
    let reviewRec = null;
    const imageViewer = { frames: [], index: 0, zoom: 1, title: '' };

    async function openReview(rec) {
        reviewRec = rec;
        if (!el.reviewModal) return;
        const titleKey = rec.verifyStatus === 'suspect' ? 'review_title' : 'record_preview';
        el.reviewTitle.textContent = I18N.t(titleKey) + ' — ' + (rec.employeeName || rec.employeeId);
        const frames = await tmsDB.getFrames(rec.recordId);
        el.reviewFrames.innerHTML = '';
        if (frames && frames.length) {
            frames.forEach((url, index) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'frame-thumb';
                btn.setAttribute('aria-label', I18N.t('image_viewer_open', { n: index + 1 }));
                btn.addEventListener('click', () => openImageViewer(frames, index, el.reviewTitle.textContent));
                const img = document.createElement('img');
                img.src = url;
                img.alt = '';
                btn.appendChild(img);
                el.reviewFrames.appendChild(btn);
            });
        } else {
            el.reviewFrames.textContent = I18N.t('review_no_frames');
        }
        el.reviewReason.style.whiteSpace = 'pre-line';
        el.reviewReason.textContent = reviewAuditText(rec);
        // 只对 AI 标记疑似伪造的记录提供人工放行；其他记录仅预览。
        el.reviewMarkBtn.style.display = (rec.verifyStatus === 'suspect') ? '' : 'none';
        el.reviewModal.classList.add('show');
    }

    function reviewAuditText(rec) {
        const conf = rec.verifyConfidence != null ? Math.round(rec.verifyConfidence * 100) + '%' : I18N.t('dash');
        const cues = Array.isArray(rec.verifySpoofCues) && rec.verifySpoofCues.length
            ? rec.verifySpoofCues.join(', ')
            : I18N.t('dash');
        const geomScore = rec.geometryScore != null ? Number(rec.geometryScore).toFixed(2) : I18N.t('dash');
        return [
            I18N.t('review_reason', { conf, reason: rec.verifyReason || I18N.t('dash') }),
            I18N.t('review_attack_type', { type: rec.verifyAttackType || 'unknown' }),
            I18N.t('review_spoof_cues', { cues }),
            I18N.t('review_uncertain', { value: rec.verifyUncertain ? I18N.t('yes') : I18N.t('no') }),
            I18N.t('review_geometry', { score: geomScore, reason: rec.geometryReason || I18N.t('dash') }),
            I18N.t('review_version', { version: rec.verifyVersion || I18N.t('dash') })
        ].join('\n');
    }
    function closeReview() {
        closeImageViewer();
        if (el.reviewModal) el.reviewModal.classList.remove('show');
        reviewRec = null;
    }
    async function markReviewed() {
        if (!reviewRec) return;
        await tmsDB.updateAttendanceVerify(reviewRec.recordId, { verifyStatus: 'reviewed', reviewedAt: Date.now() });
        toast(I18N.t('review_marked'), 'ok');
        closeReview();
        await renderRecords();
    }

    function openImageViewer(frames, index, title) {
        if (!el.imageViewerModal || !frames || !frames.length) return;
        imageViewer.frames = frames.slice();
        imageViewer.index = Math.min(Math.max(0, index || 0), imageViewer.frames.length - 1);
        imageViewer.zoom = 1;
        imageViewer.title = title || I18N.t('record_preview');
        renderImageViewer();
        el.imageViewerModal.classList.add('show');
        el.imageViewerModal.setAttribute('aria-hidden', 'false');
        if (el.imageViewerClose) el.imageViewerClose.focus();
    }

    function closeImageViewer() {
        if (!el.imageViewerModal) return;
        el.imageViewerModal.classList.remove('show');
        el.imageViewerModal.setAttribute('aria-hidden', 'true');
    }

    function renderImageViewer() {
        const total = imageViewer.frames.length;
        const index = imageViewer.index;
        const zoom = imageViewer.zoom;
        if (el.imageViewerTitle) el.imageViewerTitle.textContent = imageViewer.title || I18N.t('record_preview');
        if (el.imageViewerImg) {
            el.imageViewerImg.src = total ? imageViewer.frames[index] : '';
            el.imageViewerImg.style.width = zoom === 1 ? '' : `${zoom * 100}%`;
            el.imageViewerImg.style.maxWidth = zoom === 1 ? '100%' : 'none';
            el.imageViewerImg.style.maxHeight = zoom === 1 ? '100%' : 'none';
        }
        if (el.imageViewerCounter) el.imageViewerCounter.textContent = I18N.t('image_viewer_counter', { n: total ? index + 1 : 0, total });
        if (el.imageViewerZoomLabel) el.imageViewerZoomLabel.textContent = Math.round(zoom * 100) + '%';
        if (el.imageViewerPrev) el.imageViewerPrev.disabled = index <= 0;
        if (el.imageViewerNext) el.imageViewerNext.disabled = index >= total - 1;
        if (el.imageViewerZoomOut) el.imageViewerZoomOut.disabled = zoom <= 1;
        if (el.imageViewerZoomIn) el.imageViewerZoomIn.disabled = zoom >= 4;
        if (el.imageViewerStage) {
            el.imageViewerStage.scrollTop = 0;
            el.imageViewerStage.scrollLeft = 0;
        }
    }

    function stepImageViewer(delta) {
        if (!el.imageViewerModal || !el.imageViewerModal.classList.contains('show')) return;
        const next = imageViewer.index + delta;
        if (next < 0 || next >= imageViewer.frames.length) return;
        imageViewer.index = next;
        imageViewer.zoom = 1;
        renderImageViewer();
    }

    function zoomImageViewer(delta) {
        if (!el.imageViewerModal || !el.imageViewerModal.classList.contains('show')) return;
        imageViewer.zoom = Math.min(4, Math.max(1, Math.round((imageViewer.zoom + delta) * 4) / 4));
        renderImageViewer();
    }

    /** 把打卡记录按员工配对成工时（in→out 累加）。配对逻辑的唯一来源。
     *  @returns {Map} empId -> { name, openIn(未配对的上班时间戳|null), ms(已配对工时) }
     *  startTs/endTs 限定区间（含 start、不含 end）；缺省则全部记录。 */
    function pairAttendance(recs, startTs = -Infinity, endTs = Infinity) {
        const byEmp = new Map();
        recs.filter(r => r.timestamp >= startTs && r.timestamp < endTs)
            .sort((a, b) => a.timestamp - b.timestamp)
            .forEach(r => {
                let e = byEmp.get(r.employeeId);
                if (!e) { e = { name: r.employeeName, openIn: null, ms: 0 }; byEmp.set(r.employeeId, e); }
                if (r.type === 'in') e.openIn = r.timestamp;
                else if (r.type === 'out' && e.openIn != null) { e.ms += r.timestamp - e.openIn; e.openIn = null; }
            });
        return byEmp;
    }

    /** 按员工配对 in/out 估算今日工时（文字摘要） */
    function summarizeHours(recs) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const byEmp = pairAttendance(recs, today.getTime());
        const parts = [...byEmp.values()].map(e => {
            const h = (e.ms / 3600000);
            return I18N.t('hours_item', { name: e.name, h: h.toFixed(1) }) + (e.openIn ? I18N.t('on_duty') : '');
        });
        return parts.length ? I18N.t('hours_prefix') + parts.join(' · ') : I18N.t('no_hours');
    }

    async function exportCsv() {
        const table = ensureRecordsTable();
        if (!table.data.length) table.setData(await tmsDB.getAllAttendance());
        const recs = table.exportRows();
        if (!recs.length) { toast(I18N.t('no_records'), 'err'); return; }
        const rows = [['employeeId', 'employeeName', 'type', 'datetime', 'status', 'verification', 'ai_confidence', 'ai_reason', 'attack_type', 'spoof_cues', 'uncertain', 'verify_version', 'geometry_score', 'geometry_reason']];
        recs.forEach(r => {
            rows.push([
                r.employeeId,
                r.employeeName,
                r.type,
                new Date(r.timestamp).toISOString(),
                r.status || 'ontime',
                r.verifyStatus || 'none',
                // AI 核验留痕：置信度（%）+ 理由，供 HR 存档审计「为何被标记/放行」
                r.verifyConfidence != null ? Math.round(r.verifyConfidence * 100) + '%' : '',
                r.verifyReason || '',
                r.verifyAttackType || 'unknown',
                Array.isArray(r.verifySpoofCues) ? r.verifySpoofCues.join('|') : '',
                r.verifyUncertain ? 'true' : 'false',
                r.verifyVersion || '',
                r.geometryScore != null ? Number(r.geometryScore).toFixed(3) : '',
                r.geometryReason || ''
            ]);
        });
        const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `tms_attendance_${Date.now()}.csv`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    const csvCell = (v) => {
        let s = String(v ?? '');
        // 防公式注入：以 = + - @ Tab CR 开头的单元格在 Excel/Sheets 会被当公式执行（员工姓名可控）。
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        // \t 和 \r 同样需要包裹引号，否则 Excel 按分隔符拆列后 ' 前缀与注入内容分离。
        return /[",\n\t\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    // ============================================================
    // Tab 切换
    // ============================================================
    async function switchTab(tab) {
        document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('show', p.id === 'panel-' + tab));

        // 进出 clock 标签时启停摄像头
        if (appMode === 'enroll') return; // 注册中不打断
        stopCamera();
        appMode = 'idle';
        lastClockKey = null;

        if (tab === 'clock') {
            if (matcher && matcher.getUserCount() === 0) { showClockIdle(); }
            appMode = 'clock';
            try {
                await startCamera(el.clockVideo);
                el.clockOverlay.width = el.clockVideo.videoWidth;
                el.clockOverlay.height = el.clockVideo.videoHeight;
                if (settings.liveness) ensureLiveness();   // 非阻塞：后台加载混合活体引擎
                startLoop(el.clockOverlay);
            } catch (e) {
                el.clockHint.textContent = I18N.t('camera_error', { msg: e.message });
            }
        } else if (tab === 'records') {
            await renderRecords();
        } else if (tab === 'employees') {
            await renderEmployees();
        } else if (tab === 'dashboard') {
            await renderDashboard();
        }
    }

    // ============================================================
    // 看板
    // ============================================================
    /** 把某区间内的打卡按员工配对成工时(ms)，未配对的 in 若仍在岗则算到 untilTs */
    function workedMsInRange(recs, startTs, endTs, untilTs) {
        const byEmp = pairAttendance(recs, startTs, endTs);
        let total = 0;
        byEmp.forEach(e => {
            total += e.ms;
            if (e.openIn != null && untilTs) total += Math.max(0, untilTs - e.openIn);  // 仍在岗
        });
        return total;
    }

    async function renderDashboard() {
        const employees = await tmsDB.getAllEmployees();
        const empMap = new Map(employees.map(e => [e.id, e]));
        const recs = await tmsDB.getAllAttendance();   // desc

        // 当前在岗：每个员工最近一条记录为 in
        const latestByEmp = new Map();
        recs.forEach(r => { if (!latestByEmp.has(r.employeeId)) latestByEmp.set(r.employeeId, r); });
        const inNow = [...latestByEmp.values()].filter(r => r.type === 'in');

        // 今日迟到
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const lateToday = recs.filter(r => r.timestamp >= today.getTime() && r.type === 'in' && r.status === 'late').length;

        el.statInNow.textContent = inNow.length;
        el.statLate.textContent = lateToday;
        el.statStaff.textContent = employees.length;

        // 当前在岗列表
        el.whosInList.innerHTML = '';
        el.whosInEmpty.style.display = inNow.length ? 'none' : 'block';
        inNow.forEach(r => {
            const emp = empMap.get(r.employeeId);
            const row = document.createElement('div');
            row.className = 'whos-in-row';
            const av = buildAvatar((r.employeeName || '?').charAt(0).toUpperCase(), '', emp && emp.photo, 'emp-avatar');
            const info = document.createElement('div'); info.className = 'emp-info';
            const n = document.createElement('div'); n.className = 'emp-name'; n.textContent = r.employeeName;
            info.appendChild(n);
            const time = document.createElement('div'); time.className = 'whos-in-time';
            time.innerHTML = icon('dot') + ' ';   // 在岗状态圆点（whos-in-time 已是绿色）
            const tt = document.createElement('span');
            tt.textContent = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            time.appendChild(tt);
            row.append(av, info, time);
            el.whosInList.appendChild(row);
        });

        // 近 7 天工时柱状图
        const now = Date.now();
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
            const start = d.getTime(); const end = start + 86400000;
            const hours = workedMsInRange(recs, start, end, end > now ? now : end) / 3600000;
            days.push({ label: d.toLocaleDateString([], { weekday: 'short' }), hours });
        }
        const maxH = Math.max(1, ...days.map(d => d.hours));
        el.weeklyChart.innerHTML = '';
        days.forEach(d => {
            const col = document.createElement('div'); col.className = 'bar-col';
            const val = document.createElement('div'); val.className = 'bar-val'; val.textContent = d.hours ? d.hours.toFixed(1) : '';
            const bar = document.createElement('div'); bar.className = 'bar';
            bar.style.height = `${Math.round((d.hours / maxH) * 100)}%`;
            const day = document.createElement('div'); day.className = 'bar-day'; day.textContent = d.label;
            col.append(val, bar, day);
            el.weeklyChart.appendChild(col);
        });
    }

    // ============================================================
    // 设置
    // ============================================================
    function applySettingsToUi() {
        if (!el.thresholdInput) return;
        const identity = normalizeIdentitySettings(settings);
        settings.initialMatchConfidence = identity.initialMatchConfidence;
        settings.lockedMatchConfidence = identity.lockedMatchConfidence;
        applyTheme(settings.theme);
        el.thresholdInput.value = settings.matchThreshold;
        el.thresholdLabel.textContent = I18N.t('threshold_label', { v: settings.matchThreshold.toFixed(2) });
        if (el.initialMatchInput) {
            el.initialMatchInput.value = settings.initialMatchConfidence;
            el.initialMatchLabel.textContent = I18N.t('initial_match_label', { v: settings.initialMatchConfidence });
        }
        if (el.lockedMatchInput) {
            el.lockedMatchInput.value = settings.lockedMatchConfidence;
            el.lockedMatchLabel.textContent = I18N.t('locked_match_label', { v: settings.lockedMatchConfidence });
        }
        el.workStartInput.value = settings.workStart;
        el.workEndInput.value = settings.workEnd;
        el.graceInput.value = settings.graceMin;
        if (el.livenessToggle) el.livenessToggle.checked = !!settings.liveness;
        if (el.livenessModeSelect) el.livenessModeSelect.value = settings.livenessMode || 'deferred';
        if (el.autoRetryToggle) el.autoRetryToggle.checked = !!settings.autoRetry;
        if (el.showLivenessFramesToggle) el.showLivenessFramesToggle.checked = !!settings.showLivenessFrames;
        if (el.realProbInput) {
            el.realProbInput.value = settings.livenessRealProb;
            el.realProbLabel.textContent = I18N.t('realprob_label', { v: Number(settings.livenessRealProb).toFixed(2) });
        }
        if (el.vlmEndpointInput) el.vlmEndpointInput.value = settings.vlmEndpoint || '';
        if (el.vlmModelInput) el.vlmModelInput.value = settings.vlmModel || '';
        if (el.vlmFields) el.vlmFields.style.display = settings.liveness ? 'block' : 'none';
        if (el.soundToggle) el.soundToggle.checked = !!settings.soundEnabled;
        if (el.speakToggle) el.speakToggle.checked = !!settings.speakEnabled;
        if (el.soundFields) el.soundFields.style.display = settings.soundEnabled ? 'block' : 'none';
        if (el.voiceFields) el.voiceFields.style.display = (settings.soundEnabled && settings.speakEnabled) ? 'block' : 'none';
        updateImageViewerLabels();
        populateVoiceSelect();
    }

    function updateImageViewerLabels() {
        [
            [el.imageViewerPrev, 'image_viewer_prev'],
            [el.imageViewerNext, 'image_viewer_next'],
            [el.imageViewerZoomIn, 'image_viewer_zoom_in'],
            [el.imageViewerZoomOut, 'image_viewer_zoom_out'],
            [el.imageViewerClose, 'image_viewer_close']
        ].forEach(([node, key]) => {
            if (!node) return;
            node.setAttribute('aria-label', I18N.t(key));
            node.title = I18N.t(key);
        });
    }

    // ============================================================
    // UI 事件绑定
    // ============================================================
    function wireUi() {
        // 设置写 localStorage 失败时（隐私模式/配额满）提示用户：本次会话生效，刷新后丢失
        tmsDB.onPersistError = () => toast(I18N.t('settings_save_fail'), 'err');
        document.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });
        el.langBtn.addEventListener('click', () => I18N.toggle());
        if (el.themeBtn) {
            el.themeBtn.addEventListener('click', () => {
                const theme = normalizeTheme(settings.theme) === 'dark' ? 'light' : 'dark';
                settings = tmsDB.saveSettings({ theme });
                applyTheme(settings.theme);
            });
        }
        el.enrollBtn.addEventListener('click', openEnroll);
        el.enrollCancel.addEventListener('click', closeEnroll);
        el.exportCsvBtn.addEventListener('click', exportCsv);
        el.clearRecordsBtn.addEventListener('click', async () => {
            if (!confirm(I18N.t('clear_confirm'))) return;
            await tmsDB.clearAttendance();
            await renderRecords();
            toast(I18N.t('cleared'), 'ok');
        });
        if (el.verifyRunBtn) el.verifyRunBtn.addEventListener('click', () => runBatchVerify());
        if (el.verifyRetryBtn) el.verifyRetryBtn.addEventListener('click', () => runBatchVerify(['error']));   // 只重跑失败
        // 手动改搜索框时同步快捷筛选条（清空或改成别的词 → 高亮/计数更新）
        if (el.recordsFilter) el.recordsFilter.addEventListener('input', updateFilterChips);
        if (el.reviewMarkBtn) el.reviewMarkBtn.addEventListener('click', markReviewed);
        if (el.reviewClose) el.reviewClose.addEventListener('click', closeReview);
        if (el.reviewModal) el.reviewModal.addEventListener('click', (e) => { if (e.target === el.reviewModal) closeReview(); });
        if (el.imageViewerClose) el.imageViewerClose.addEventListener('click', closeImageViewer);
        if (el.imageViewerPrev) el.imageViewerPrev.addEventListener('click', () => stepImageViewer(-1));
        if (el.imageViewerNext) el.imageViewerNext.addEventListener('click', () => stepImageViewer(1));
        if (el.imageViewerZoomIn) el.imageViewerZoomIn.addEventListener('click', () => zoomImageViewer(0.25));
        if (el.imageViewerZoomOut) el.imageViewerZoomOut.addEventListener('click', () => zoomImageViewer(-0.25));
        if (el.imageViewerModal) el.imageViewerModal.addEventListener('click', (e) => { if (e.target === el.imageViewerModal) closeImageViewer(); });
        document.addEventListener('keydown', (e) => {
            if (!el.imageViewerModal || !el.imageViewerModal.classList.contains('show')) return;
            if (e.key === 'Escape') { e.preventDefault(); closeImageViewer(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); stepImageViewer(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); stepImageViewer(1); }
            else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomImageViewer(0.25); }
            else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomImageViewer(-0.25); }
        });
        if (el.thresholdInput) {
            el.thresholdInput.addEventListener('input', () => {
                const v = Math.min(SAFE_MATCH_THRESHOLD, parseFloat(el.thresholdInput.value));
                el.thresholdInput.value = v;
                el.thresholdLabel.textContent = I18N.t('threshold_label', { v: v.toFixed(2) });
                settings = tmsDB.saveSettings({ matchThreshold: v });
                if (matcher) matcher.config.matchThreshold = v;
            });
        }
        if (el.initialMatchInput) {
            el.initialMatchInput.addEventListener('input', () => {
                saveIdentitySettings({ initialMatchConfidence: el.initialMatchInput.value });
            });
        }
        if (el.lockedMatchInput) {
            el.lockedMatchInput.addEventListener('input', () => {
                saveIdentitySettings({ lockedMatchConfidence: el.lockedMatchInput.value });
            });
        }
        el.workStartInput.addEventListener('change', () => { settings = tmsDB.saveSettings({ workStart: el.workStartInput.value || '09:00' }); });
        el.workEndInput.addEventListener('change', () => { settings = tmsDB.saveSettings({ workEnd: el.workEndInput.value || '18:00' }); });
        el.graceInput.addEventListener('change', () => { settings = tmsDB.saveSettings({ graceMin: parseInt(el.graceInput.value, 10) || 0 }); });
        if (el.livenessToggle) {
            el.livenessToggle.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ liveness: el.livenessToggle.checked });
                tracker.clear();
                lastClockDets = [];
                lastClockKey = null;
                if (el.vlmFields) el.vlmFields.style.display = settings.liveness ? 'block' : 'none';
                // 开启时立刻做健康检查连 LM Studio（首帧再等会卡顿）；关闭则无需动作
                if (settings.liveness) ensureLiveness();
            });
        }
        if (el.realProbInput) {
            el.realProbInput.addEventListener('input', () => {
                const v = Math.min(0.9, Math.max(0.3, parseFloat(el.realProbInput.value)));
                el.realProbInput.value = v;
                el.realProbLabel.textContent = I18N.t('realprob_label', { v: v.toFixed(2) });
                settings = tmsDB.saveSettings({ livenessRealProb: v });
                if (liveness) liveness.threshold = v;   // 客户端已建则即时生效
            });
        }
        if (el.livenessModeSelect) {
            el.livenessModeSelect.addEventListener('change', () => {
                const m = el.livenessModeSelect.value === 'realtime' ? 'realtime' : 'deferred';
                settings = tmsDB.saveSettings({ livenessMode: m });
            });
        }
        if (el.autoRetryToggle) {
            el.autoRetryToggle.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ autoRetry: el.autoRetryToggle.checked });
                if (settings.autoRetry) startAutoRetryPoll(); else stopAutoRetryPoll();
            });
        }
        if (el.showLivenessFramesToggle) {
            el.showLivenessFramesToggle.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ showLivenessFrames: el.showLivenessFramesToggle.checked });
            });
        }
        // 改 LM Studio 地址 / 模型 → 存设置并丢弃旧客户端，下次开启活体时按新值重建
        function resetVlmClient() { liveness = null; livenessInitPromise = null; }
        if (el.vlmEndpointInput) {
            el.vlmEndpointInput.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ vlmEndpoint: el.vlmEndpointInput.value.trim() || 'http://127.0.0.1:6501/v1' });
                resetVlmClient();
                if (settings.liveness) ensureLiveness();
            });
        }
        if (el.vlmModelInput) {
            el.vlmModelInput.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ vlmModel: el.vlmModelInput.value.trim() || 'minicpm-v-4.6' });
                resetVlmClient();
                if (settings.liveness) ensureLiveness();
            });
        }
        if (el.soundToggle) {
            el.soundToggle.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ soundEnabled: el.soundToggle.checked });
                if (el.soundFields) el.soundFields.style.display = settings.soundEnabled ? 'block' : 'none';
                if (el.voiceFields) el.voiceFields.style.display = (settings.soundEnabled && settings.speakEnabled) ? 'block' : 'none';
            });
        }
        if (el.speakToggle) {
            el.speakToggle.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ speakEnabled: el.speakToggle.checked });
                if (el.voiceFields) el.voiceFields.style.display = (settings.soundEnabled && settings.speakEnabled) ? 'block' : 'none';
            });
        }
        if (el.voiceSelect) {
            el.voiceSelect.addEventListener('change', () => {
                setVoiceURIFor(I18N.lang, el.voiceSelect.value);   // 按当前 UI 语言分槽保存
            });
        }
        if (el.voiceTestBtn) {
            el.voiceTestBtn.addEventListener('click', () => {
                speak(I18N.t('voice_in', { name: 'Test' }));
            });
        }
        // 异步加载（Chrome 首次 getVoices() 为空，voices loaded 后触发）
        if ('speechSynthesis' in window) {
            speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);
        }

        el.empName.addEventListener('keydown', (e) => { if (e.key === 'Enter') openEnroll(); });

        // 页面隐藏时释放摄像头（移动端切后台）
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && appMode === 'clock') stopCamera();
            else if (!document.hidden && appMode === 'clock' && !stream) switchTab('clock');
        });
    }

    // ============================================================
    // PWA：注册 SW + 监听更新 → 提示强制刷新
    // ============================================================
    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js').then(reg => {
            // 发现等待中的新版本
            if (reg.waiting) showUpdate(reg.waiting);
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                if (!nw) return;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdate(nw);
                    }
                });
            });
        }).catch(() => {});

        // 新 SW 接管后强制 reload 一次，确保运行最新代码
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloaded) return;
            reloaded = true;
            window.location.reload();
        });
    }

    function showUpdate(worker) {
        el.updateBanner.classList.add('show');
        el.reloadBtn.onclick = () => worker.postMessage({ type: 'SKIP_WAITING' });
    }

    // ============================================================
    // 小工具
    // ============================================================
    function setBoot(t) { if (el.bootStatus) el.bootStatus.textContent = t; }
    function hideBoot() { el.bootOverlay.classList.add('hidden'); }
    let toastTimer = null;
    function toast(msg, kind = 'ok') {
        el.toast.textContent = msg;
        el.toast.className = 'toast show ' + kind;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.toast.className = 'toast'; }, 2200);
    }

    window.addEventListener('DOMContentLoaded', boot);
})();
