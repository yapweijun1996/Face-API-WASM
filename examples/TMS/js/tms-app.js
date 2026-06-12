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

    // ---------- 运行状态 ----------
    let settings = tmsDB.getSettings();
    let matcher = null;
    let empPhotos = new Map();        // employeeId -> 脸部缩略图 dataURL，供打卡卡片显示
    let regManager = null;
    let appMode = 'idle';            // 'idle' | 'clock' | 'enroll'
    let stream = null;
    let activeVideo = null;
    let loopHandle = null;
    let detecting = false;

    // 打卡防抖：记录每个员工最近一次成功打卡时间，冷却期内忽略
    const cooldown = new Map();
    let lastClockKey = null;          // 当前 clock 面板展示的员工，避免重复渲染

    // 实时打卡（自动）+ 活体检测状态
    const HOLD_MS = 1500;             // 对准保持多久自动打卡
    const BLINK_EAR = 0.21;           // 眼睛纵横比低于此值视为闭眼（眨眼）
    let lastClockDets = [];          // 最近一帧所有检测到的脸：[{ box, match }]（多人）
    const holdStates = new Map();    // empId -> 每张脸独立的 hold 状态
    let particles = [];              // 打卡成功的庆祝粒子
    let lastPrimaryId = null;        // 侧边卡片当前展示的员工（用于迟滞，避免抖动）

    const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const el = {};
    function cacheDom() {
        [
            'bootOverlay', 'bootStatus', 'toast', 'updateBanner', 'reloadBtn',
            'clockVideo', 'clockOverlay', 'clockCard', 'clockHint', 'empCountPill', 'langBtn',
            'empList', 'empName', 'empDept', 'enrollBtn', 'empEmpty',
            'enrollModal', 'enrollVideo', 'enrollOverlay', 'enrollBar', 'enrollText',
            'enrollThumbs', 'enrollCancel', 'enrollTitle',
            'recordsBody', 'recordsSummary', 'recordsEmpty', 'exportCsvBtn', 'clearRecordsBtn',
            'thresholdInput', 'thresholdVal', 'thresholdLabel',
            'workStartInput', 'workEndInput', 'graceInput',
            'statInNow', 'statLate', 'statStaff', 'whosInList', 'whosInEmpty', 'weeklyChart'
        ].forEach(id => { el[id] = $(id); });
    }

    // ============================================================
    // 初始化
    // ============================================================
    async function boot() {
        cacheDom();
        I18N.apply();
        el.langBtn.textContent = I18N.other;
        I18N.onChange.push(onLangChange);
        wireUi();
        registerServiceWorker();

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
        // 清理已删除员工残留的冷却/hold 记录，避免随增删循环无限增长
        for (const id of [...cooldown.keys()]) if (!empPhotos.has(id)) cooldown.delete(id);
        for (const id of [...holdStates.keys()]) if (!empPhotos.has(id)) holdStates.delete(id);
        el.empCountPill.textContent = I18N.t('emp_count', { n: employees.length });
        return employees;
    }

    // ============================================================
    // 摄像头
    // ============================================================
    async function startCamera(videoEl) {
        if (stream) stopCamera();
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        activeVideo = videoEl;
        videoEl.srcObject = stream;
        await new Promise((resolve) => {
            videoEl.onloadedmetadata = () => { videoEl.play(); resolve(); };
        });
    }

    function stopCamera() {
        detecting = false;
        if (loopHandle) { cancelAnimationFrame(loopHandle); loopHandle = null; }
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        if (activeVideo) { activeVideo.srcObject = null; activeVideo = null; }
        // 清空逐帧的临时状态，避免下次开摄像头时：
        //  - 用旧坐标画出残影框（overlay 尺寸可能已变）
        //  - 冻结的 hold（旧 startTs）在回到打卡页第一帧就「秒打卡」并绕过活体
        holdStates.clear();
        lastClockDets = [];
        particles = [];
        lastClockKey = null;
        lastPrimaryId = null;
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

        // clock 模式检测更快（120ms）以捕捉眨眼；enroll 模式 200ms 省电
        const interval = appMode === 'clock' ? 120 : 200;

        const loop = async (ts) => {
            if (!detecting || !activeVideo) return;

            // 逐帧重绘 clock 叠加层，让倒计时环平滑动画（即使检测被节流）
            if (ctx && appMode === 'clock') drawClockOverlay(ctx, overlay);

            if (!busy && ts - lastRun > interval && activeVideo.readyState === activeVideo.HAVE_ENOUGH_DATA) {
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
        const x = overlay.width - b.x - b.width;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 3;
        ctx.strokeRect(x, b.y, b.width, b.height);
    }

    // ---------- 眼睛纵横比（眨眼检测） ----------
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function earOf(eye) {
        // eye: 6 点；EAR =(|p1-p5|+|p2-p4|)/(2|p0-p3|)
        return (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * dist(eye[0], eye[3]) || 1);
    }
    function blinkNow(det) {
        try {
            const l = det.landmarks.getLeftEye();
            const r = det.landmarks.getRightEye();
            return (earOf(l) + earOf(r)) / 2 < BLINK_EAR;
        } catch (e) { return false; }
    }

    // ---------- clock 实时叠加层：人脸框 + 姓名 + 倒计时环 + 提示 ----------
    // ---------- 打卡成功庆祝粒子 ----------
    function spawnCelebration(cx, cy, type) {
        if (particles.length > 320) return;   // 多人同时打卡时给粒子数封顶
        const palette = type === 'in'
            ? ['#22c55e', '#4ade80', '#22d3ee', '#a3e635']
            : ['#f43f5e', '#fb7185', '#22d3ee', '#fbbf24'];
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
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawClockOverlay(ctx, overlay) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        drawParticles(ctx);          // 粒子始终绘制（即使人脸已离开）
        for (const item of lastClockDets) {
            drawFace(ctx, overlay, item.box, item.match);
        }
    }

    // 画单张脸：人脸框 +（若已识别）姓名标签 + 倒计时环 + 提示
    function drawFace(ctx, overlay, b, match) {
        const x = overlay.width - b.x - b.width;     // 翻转 x 对齐镜像视频
        const y = b.y;
        const hs = match ? holdStates.get(match.emp.id) : null;

        const done = hs && hs.phase === 'done';
        const color = !match ? 'rgba(148,163,184,.75)'         // 未识别：灰
            : done ? '#22c55e'
                : (hs && hs.action === 'in' ? '#22c55e' : '#f43f5e');

        // 人脸框
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, b.width, b.height);

        if (!match) return;          // 未识别的脸只画灰框

        // 姓名标签（canvas 未镜像，文字可正常阅读）
        const label = match.emp.name;
        ctx.font = '600 18px -apple-system, "PingFang SC", sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(15,23,42,.85)';
        ctx.fillRect(x, y - 30, tw + 16, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 8, y - 11);

        if (!hs) return;

        // 倒计时环（人脸右上角）
        const cx = x + b.width + 4, cy = y + 18, rad = 16;
        let prog = 0, hint = '';
        if (hs.phase === 'done') { prog = 1; }
        else if (!hs.blinked) { prog = 0.15; hint = I18N.t('liveness_blink'); }
        else {
            prog = Math.min(1, (performance.now() - hs.startTs) / HOLD_MS);
            hint = I18N.t(hs.action === 'in' ? 'clock_in_btn' : 'clock_out_btn');
        }
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 4; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
        if (hs.phase === 'done') {
            ctx.fillStyle = color; ctx.font = '700 16px sans-serif'; ctx.fillText('✓', cx - 5, cy + 6);
        }

        // 底部提示
        if (hint) {
            ctx.font = '600 15px -apple-system, sans-serif';
            const hw = ctx.measureText(hint).width;
            ctx.fillStyle = 'rgba(15,23,42,.85)';
            ctx.fillRect(x, y + b.height + 6, hw + 16, 24);
            ctx.fillStyle = color;
            ctx.fillText(hint, x + 8, y + b.height + 23);
        }
    }

    // ============================================================
    // 打卡识别（多人同时）
    // ============================================================
    async function handleClockFrameMulti(dets) {
        const present = new Set();
        const processed = new Set();   // 本帧已处理的 empId，挡住「同一人被两张脸匹配」导致的重复打卡
        const drawList = [];
        const matchedFaces = [];       // 已识别的脸，用于挑选侧边卡片
        let justClocked = null;        // 本帧刚打卡成功者，卡片优先展示其 ✓

        for (const det of dets) {
            const box = det.detection.box;
            const result = matcher ? matcher.findBestMatch(det.descriptor) : { status: 'unknown' };

            if (result.status !== 'matched') {
                drawList.push({ box, match: null });
                continue;
            }

            const emp = result.user;
            present.add(emp.id);
            drawList.push({ box, match: { emp, confidence: result.confidence } });
            matchedFaces.push({ emp, confidence: result.confidence, box });

            // 同一人本帧已处理过（照片/双胞胎/反射造成的第二张脸）→ 只画框，不再推进 hold
            if (processed.has(emp.id)) continue;
            processed.add(emp.id);

            // 冷却中：刚打过卡，保持 done 态展示 ✓
            const last = cooldown.get(emp.id);
            if (last && Date.now() - last < settings.clockCooldownMs) {
                const prev = holdStates.get(emp.id);
                holdStates.set(emp.id, {
                    id: emp.id, name: emp.name,
                    action: prev ? prev.action : 'in',
                    phase: 'done', blinked: true, eyesOpenSeen: true, startTs: 0, lastSeen: performance.now()
                });
                continue;
            }

            // 每张脸独立的 hold 状态
            let hs = holdStates.get(emp.id);
            if (!hs || hs.phase === 'done') {
                const lastRec = await tmsDB.getLastAttendance(emp.id);
                const nextType = lastRec && lastRec.type === 'in' ? 'out' : 'in';
                hs = { id: emp.id, name: emp.name, action: nextType, startTs: performance.now(), blinked: false, eyesOpenSeen: false, phase: 'hold', lastSeen: performance.now() };
                holdStates.set(emp.id, hs);
            }
            hs.lastSeen = performance.now();

            // 活体：必须先看到「睁眼」再看到「闭眼」才算一次真眨眼——
            // 静态照片要么一直睁、要么一直闭，无法产生「睁→闭」跳变，骗不过。
            if (!hs.blinked) {
                const closed = blinkNow(det);
                if (!closed) hs.eyesOpenSeen = true;
                else if (hs.eyesOpenSeen) { hs.blinked = true; hs.startTs = performance.now(); }
            }

            // 已眨眼 + 保持足够时长 → 自动打卡
            if (hs.blinked && performance.now() - hs.startTs >= HOLD_MS) {
                hs.phase = 'done';
                if (await doClock(emp, hs.action, box)) justClocked = { emp, confidence: result.confidence };
            }
        }

        lastClockDets = drawList;

        // 清理离开画面超过 1.2s 的 hold 状态（容忍偶发漏检，不会一帧丢失就重置倒计时）
        for (const [id, hs] of holdStates) {
            if (!present.has(id) && performance.now() - (hs.lastSeen || 0) > 1200) holdStates.delete(id);
        }

        // 侧边卡片：优先展示刚打卡成功者；否则展示「上一个 primary（若仍在画面）」或最大的脸（迟滞，避免两张相近大小的脸来回抖动）
        let target = justClocked;
        if (!target && matchedFaces.length) {
            const sticky = matchedFaces.find(f => f.emp.id === lastPrimaryId);
            const biggest = matchedFaces.reduce((a, b) => (b.box.width * b.box.height > a.box.width * a.box.height ? b : a));
            // 仅当别的脸明显更大（>1.3x）才切换，否则保持上一个
            target = (sticky && biggest.box.width * biggest.box.height < sticky.box.width * sticky.box.height * 1.3) ? sticky : biggest;
        }

        if (target) {
            lastPrimaryId = target.emp.id;
            const hs = holdStates.get(target.emp.id);
            const phase = hs ? (hs.phase === 'done' ? 'done' : (hs.blinked ? 'holding' : 'blink')) : 'holding';
            renderClockStatus(target.emp, target.confidence, phase, hs);
        } else if (dets.length) {
            lastPrimaryId = null;
            showClockNoMatch();
        } else {
            lastPrimaryId = null;
            showClockIdle();
        }
    }

    function renderClockStatus(emp, confidence, phase, hs) {
        const key = emp.id + ':' + phase;
        if (key === lastClockKey) return;
        lastClockKey = key;

        const initial = (emp.name || '?').charAt(0).toUpperCase();
        const photo = empPhotos.get(emp.id);
        const action = hs ? hs.action : 'in';
        const cls = phase === 'done' ? 'ok' : (action === 'in' ? 'in' : 'out');

        let sub;
        if (phase === 'done') sub = I18N.t('clock_recorded', { c: confidence.toFixed(0) });
        else if (phase === 'blink') sub = I18N.t('liveness_blink');
        else sub = I18N.t(action === 'in' ? 'hold_to_in' : 'hold_to_out');

        el.clockCard.innerHTML = '';
        el.clockCard.append(buildAvatar(initial, cls, photo), buildText(emp.name, sub));
        if (phase === 'done') {
            const badge = document.createElement('div');
            badge.className = 'clock-badge ok';
            badge.textContent = I18N.t('clock_done');
            el.clockCard.appendChild(badge);
        }
        el.clockCard.className = 'clock-card show';
        el.clockHint.textContent = '';
    }

    function buildAvatar(initial, cls, photo) {
        const a = document.createElement('div');
        a.className = 'clock-avatar ' + cls;
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

    async function doClock(emp, type, box) {
        lastClockKey = null;
        const status = computeStatus(type, Date.now());
        // handleClockFrameMulti 是被 await 的，这里不会并发重入；
        // 写库成功后再置冷却 + 反馈，写失败则回退该员工的 hold 让其可重试。
        try {
            await tmsDB.addAttendance({ employeeId: emp.id, employeeName: emp.name, type, status });
        } catch (e) {
            holdStates.delete(emp.id);   // 仅回退该员工，不影响画面里其他人
            toast(I18N.t('clock_fail', { msg: e.message }), 'err');
            return false;
        }
        cooldown.set(emp.id, Date.now());
        // 从这张脸的位置迸发庆祝粒子（坐标翻转对齐镜像视频）
        if (box && el.clockOverlay) {
            spawnCelebration(el.clockOverlay.width - box.x - box.width / 2, box.y + box.height / 2, type);
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
    let audioCtx = null;
    function beep(freq) {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.frequency.value = freq; o.type = 'sine';
            o.connect(g); g.connect(audioCtx.destination);
            g.gain.setValueAtTime(0.18, audioCtx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
            o.start(); o.stop(audioCtx.currentTime + 0.25);
        } catch (e) {}
    }
    function speak(text) {
        try {
            if (!('speechSynthesis' in window)) return;
            const u = new SpeechSynthesisUtterance(text);
            u.lang = I18N.lang === 'zh' ? 'zh-CN' : 'en-US';
            u.rate = 1.0;
            speechSynthesis.cancel();
            speechSynthesis.speak(u);
        } catch (e) {}
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
        await startCamera(el.enrollVideo);
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

            const av = document.createElement('div');
            av.className = 'emp-avatar';
            if (emp.photo) {
                const img = document.createElement('img');
                img.src = emp.photo;
                av.appendChild(img);
            } else {
                av.textContent = (emp.name || '?').charAt(0).toUpperCase();
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

            const del = document.createElement('button');
            del.className = 'emp-del';
            del.textContent = '🗑';
            del.onclick = async () => {
                if (!confirm(I18N.t('emp_delete_confirm', { name: emp.name }))) return;
                await tmsDB.deleteEmployee(emp.id);
                await reloadMatcher();
                await renderEmployees();
                toast(I18N.t('deleted'), 'ok');
            };

            row.append(av, info, del);
            el.empList.appendChild(row);
        });
    }

    // ============================================================
    // 考勤记录
    // ============================================================
    async function renderRecords() {
        const recs = await tmsDB.getAllAttendance();
        el.recordsBody.innerHTML = '';
        el.recordsEmpty.style.display = recs.length ? 'none' : 'block';

        recs.forEach(r => {
            const tr = document.createElement('tr');
            const t = new Date(r.timestamp);
            const cells = [
                r.employeeName,
                r.type === 'in' ? I18N.t('type_in') : I18N.t('type_out'),
                t.toLocaleDateString(),
                t.toLocaleTimeString()
            ];
            cells.forEach((txt, i) => {
                const td = document.createElement('td');
                td.textContent = txt;
                if (i === 1) td.className = r.type === 'in' ? 'cell-in' : 'cell-out';
                tr.appendChild(td);
            });
            // 状态徽章
            const stTd = document.createElement('td');
            const st = r.status || 'ontime';
            if (st !== 'ontime') {
                const badge = document.createElement('span');
                badge.className = 'status-badge ' + st;
                badge.textContent = I18N.t('status_' + st);
                stTd.appendChild(badge);
            } else {
                stTd.textContent = I18N.t('status_ontime');
                stTd.className = 'cell-muted';
            }
            tr.appendChild(stTd);
            el.recordsBody.appendChild(tr);
        });

        el.recordsSummary.textContent = summarizeHours(recs);
    }

    /** 按员工配对 in/out 估算今日工时 */
    function summarizeHours(recs) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const byEmp = {};
        recs.filter(r => r.timestamp >= today.getTime())
            .sort((a, b) => a.timestamp - b.timestamp)
            .forEach(r => {
                (byEmp[r.employeeId] = byEmp[r.employeeId] || { name: r.employeeName, openIn: null, ms: 0 });
                const e = byEmp[r.employeeId];
                if (r.type === 'in') e.openIn = r.timestamp;
                else if (r.type === 'out' && e.openIn) { e.ms += r.timestamp - e.openIn; e.openIn = null; }
            });
        const parts = Object.values(byEmp).map(e => {
            const h = (e.ms / 3600000);
            return I18N.t('hours_item', { name: e.name, h: h.toFixed(1) }) + (e.openIn ? I18N.t('on_duty') : '');
        });
        return parts.length ? I18N.t('hours_prefix') + parts.join(' · ') : I18N.t('no_hours');
    }

    async function exportCsv() {
        const recs = await tmsDB.getAllAttendance();
        if (!recs.length) { toast(I18N.t('no_records'), 'err'); return; }
        const rows = [['employeeId', 'employeeName', 'type', 'datetime']];
        recs.slice().reverse().forEach(r => {
            rows.push([r.employeeId, r.employeeName, r.type, new Date(r.timestamp).toISOString()]);
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
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
                startLoop(el.clockOverlay);
            } catch (e) {
                el.clockHint.textContent = '无法访问摄像头：' + e.message;
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
        const byEmp = {};
        recs.filter(r => r.timestamp >= startTs && r.timestamp < endTs)
            .sort((a, b) => a.timestamp - b.timestamp)
            .forEach(r => {
                const e = (byEmp[r.employeeId] = byEmp[r.employeeId] || { openIn: null, ms: 0 });
                if (r.type === 'in') e.openIn = r.timestamp;
                else if (r.type === 'out' && e.openIn) { e.ms += r.timestamp - e.openIn; e.openIn = null; }
            });
        let total = 0;
        Object.values(byEmp).forEach(e => {
            total += e.ms;
            if (e.openIn && untilTs) total += Math.max(0, untilTs - e.openIn);  // 仍在岗
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
            const av = document.createElement('div');
            av.className = 'emp-avatar';
            if (emp && emp.photo) { const img = document.createElement('img'); img.src = emp.photo; av.appendChild(img); }
            else av.textContent = (r.employeeName || '?').charAt(0).toUpperCase();
            const info = document.createElement('div'); info.className = 'emp-info';
            const n = document.createElement('div'); n.className = 'emp-name'; n.textContent = r.employeeName;
            info.appendChild(n);
            const time = document.createElement('div'); time.className = 'whos-in-time';
            time.textContent = '🟢 ' + new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
        el.thresholdInput.value = settings.matchThreshold;
        el.thresholdLabel.textContent = I18N.t('threshold_label', { v: settings.matchThreshold.toFixed(2) });
        el.workStartInput.value = settings.workStart;
        el.workEndInput.value = settings.workEnd;
        el.graceInput.value = settings.graceMin;
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
        el.enrollBtn.addEventListener('click', openEnroll);
        el.enrollCancel.addEventListener('click', closeEnroll);
        el.exportCsvBtn.addEventListener('click', exportCsv);
        el.clearRecordsBtn.addEventListener('click', async () => {
            if (!confirm(I18N.t('clear_confirm'))) return;
            await tmsDB.clearAttendance();
            await renderRecords();
            toast(I18N.t('cleared'), 'ok');
        });
        if (el.thresholdInput) {
            el.thresholdInput.addEventListener('input', () => {
                const v = parseFloat(el.thresholdInput.value);
                el.thresholdLabel.textContent = I18N.t('threshold_label', { v: v.toFixed(2) });
                settings = tmsDB.saveSettings({ matchThreshold: v });
                if (matcher) matcher.config.matchThreshold = v;
            });
        }
        el.workStartInput.addEventListener('change', () => { settings = tmsDB.saveSettings({ workStart: el.workStartInput.value || '09:00' }); });
        el.workEndInput.addEventListener('change', () => { settings = tmsDB.saveSettings({ workEnd: el.workEndInput.value || '18:00' }); });
        el.graceInput.addEventListener('change', () => { settings = tmsDB.saveSettings({ graceMin: parseInt(el.graceInput.value, 10) || 0 }); });
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
