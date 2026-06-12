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
        unmatched: 'rgba(148,163,184,.75)'
    };
    // canvas 未镜像、视频 CSS 镜像：把检测坐标的 x 翻转过来对齐镜像画面
    const mirrorX = (overlayW, x, w) => overlayW - x - w;

    const detectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

    // MiniFASNet-V2 ONNX anti-spoofing: input 1x3x80x80 BGR float32 [0,1].
    // Upstream Silent-Face-Anti-Spoofing treats argmax class 1 as Real Face.
    const LIVENESS_MODEL_URL = './models/minifasnet_v2.onnx';
    const LIVENESS_REAL_CLASS_INDEX = 1;
    const LIVENESS_LIVE_THRESHOLD = 0.50;
    const antiSpoof = {
        session: null,
        loading: null,
        inputName: null,
        outputName: null
    };

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
            'thresholdInput', 'thresholdVal', 'thresholdLabel', 'livenessToggle',
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

    async function initAntiSpoof() {
        if (antiSpoof.session) return antiSpoof.session;
        if (antiSpoof.loading) return antiSpoof.loading;
        antiSpoof.loading = (async () => {
            if (!window.ort) throw new Error('ONNX Runtime Web not loaded');
            ort.env.wasm.wasmPaths = './';
            ort.env.wasm.numThreads = 1;
            const session = await ort.InferenceSession.create(LIVENESS_MODEL_URL, {
                executionProviders: ['wasm']
            });
            antiSpoof.session = session;
            antiSpoof.inputName = session.inputNames[0];
            antiSpoof.outputName = session.outputNames[0];
            return session;
        })().finally(() => {
            antiSpoof.loading = null;
        });
        return antiSpoof.loading;
    }

    function softmax(values) {
        const max = Math.max(...values);
        const exps = values.map(v => Math.exp(v - max));
        const sum = exps.reduce((a, b) => a + b, 0) || 1;
        return exps.map(v => v / sum);
    }

    function makeLivenessTensor(video, box) {
        const size = Math.max(box.width, box.height) * 2.7;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const sx = Math.max(0, cx - size / 2);
        const sy = Math.max(0, cy - size / 2);
        const ex = Math.min(video.videoWidth, cx + size / 2);
        const ey = Math.min(video.videoHeight, cy + size / 2);

        const canvas = document.createElement('canvas');
        canvas.width = 80;
        canvas.height = 80;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, sx, sy, Math.max(1, ex - sx), Math.max(1, ey - sy), 0, 0, 80, 80);

        const rgba = ctx.getImageData(0, 0, 80, 80).data;
        const input = new Float32Array(3 * 80 * 80);
        for (let i = 0; i < 80 * 80; i++) {
            const p = i * 4;
            input[i] = rgba[p + 2] / 255;
            input[80 * 80 + i] = rgba[p + 1] / 255;
            input[2 * 80 * 80 + i] = rgba[p] / 255;
        }
        return new ort.Tensor('float32', input, [1, 3, 80, 80]);
    }

    async function predictLiveness(video, box) {
        const session = await initAntiSpoof();
        const tensor = makeLivenessTensor(video, box);
        const output = await session.run({ [antiSpoof.inputName]: tensor });
        const raw = Array.from(output[antiSpoof.outputName].data).slice(0, 3);
        const prob = softmax(raw);
        const label = prob.indexOf(Math.max(...prob));
        return {
            live: prob[LIVENESS_REAL_CLASS_INDEX],
            print: prob[0],
            replay: prob[2],
            label,
            passed: label === LIVENESS_REAL_CLASS_INDEX && prob[LIVENESS_REAL_CLASS_INDEX] >= LIVENESS_LIVE_THRESHOLD
        };
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
        //  - 冻结的 track（旧 startTs）在回到打卡页第一帧就「秒打卡」并绕过活体
        tracker.clear();
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

        // clock 模式检测更快（120ms）以提升真人检测和倒计时反馈；enroll 模式 200ms 省电
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
            ? [COLORS.in, '#4ade80', COLORS.accent, '#a3e635']
            : [COLORS.out, '#fb7185', COLORS.accent, '#fbbf24'];
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
            : (hs && hs.phase === 'spoof') ? COLORS.warn
            : done ? COLORS.in
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
        ctx.fillStyle = 'rgba(15,23,42,.85)';
        ctx.fillRect(x, y - 30, tw + 16, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 8, y - 11);

        if (!hs) return;

        // 倒计时环（人脸右上角）
        const cx = x + b.width + 4, cy = y + 18, rad = 16;
        let prog = 0, hint = '';
        if (hs.phase === 'done') { prog = 1; }
        else if (hs.phase === 'checking') { prog = 0.35; hint = I18N.t('liveness_checking'); }
        else if (hs.phase === 'spoof') { prog = 1; hint = I18N.t('liveness_failed'); }
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
        const now = performance.now();
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

            if (result.status !== 'matched') {
                track.data.empId = null;   // 这张脸暂不认识，清掉旧绑定
                drawList.push({ box, match: null, hold: null });
                continue;
            }

            const emp = result.user;
            const d = track.data;

            // track 改绑了不同员工（人换了 / 误识别跳变）→ 重置该 track 的 hold
            if (d.empId !== emp.id) {
                d.empId = emp.id; d.name = emp.name;
                d.action = null; d.startTs = now; d.livePassed = !settings.liveness; d.liveScore = 0; d.phase = 'hold';
            }
            d.confidence = result.confidence;

            drawList.push({ box, match: { emp, confidence: result.confidence }, hold: d });
            matchedFaces.push({ track, emp, confidence: result.confidence, box });

            // 冷却中：该员工刚打过卡 → 这张脸保持 done 展示 ✓（哪怕是另一张脸/另一个 track）
            const last = cooldown.get(emp.id);
            if (last && Date.now() - last < settings.clockCooldownMs) {
                d.phase = 'done'; d.livePassed = true;
                if (d.action == null) d.action = 'in';
                continue;
            }
            // 这张脸已完成本轮打卡；冷却刚到期 → 重置状态，下帧开启新一轮
            if (d.phase === 'done') {
                d.phase = 'hold'; d.action = null; d.livePassed = false; d.startTs = now;
                continue;
            }

            // 首次：决定本次是上班还是下班
            if (d.action == null) {
                const lastRec = await tmsDB.getLastAttendance(emp.id);
                d.action = lastRec && lastRec.type === 'in' ? 'out' : 'in';
                d.startTs = now;
            }

            if (settings.liveness) {
                if (!d.livePassed) {
                    d.phase = 'checking';
                    try {
                        const live = await predictLiveness(activeVideo, box);
                        d.liveScore = live.live;
                        d.livePassed = live.passed;
                        d.phase = live.passed ? 'hold' : 'spoof';
                        d.startTs = now;
                    } catch (e) {
                        d.phase = 'spoof';
                        toast(I18N.t('liveness_model_fail', { msg: e.message }), 'err');
                    }
                    if (!d.livePassed) continue;
                }
            } else {
                d.livePassed = true;
            }

            // 已通过真人检测 + 保持足够时长 → 自动打卡
            if (d.livePassed && now - d.startTs >= HOLD_MS) {
                d.phase = 'done';
                // 同帧/冷却双重去重：同一员工被两张脸同时拍到时只写一次
                const c = cooldown.get(emp.id);
                const inCooldown = c && Date.now() - c < settings.clockCooldownMs;
                if (!inCooldown && !clockedThisFrame.has(emp.id)) {
                    clockedThisFrame.add(emp.id);
                    if (await doClock(emp, d.action, box)) {
                        justClocked = { emp, confidence: result.confidence };
                    } else {
                        // 写库失败 → 回退该 track，使其下一轮重新倒计时打卡（保留已通过的活体）
                        d.phase = 'hold'; d.startTs = now;
                        clockedThisFrame.delete(emp.id);
                    }
                }
            }
        }

        lastClockDets = drawList;
        // 过期 track 由 tracker 自身淘汰，无需手动清理

        // 侧边卡片：优先刚打卡成功者；否则保持上一个 primary（仍在画面时）或最大的脸
        //（迟滞：仅当别的脸明显更大 >1.3x 才切换，避免两张相近大小的脸来回抖动）
        let target = justClocked ? matchedFaces.find(f => f.emp.id === justClocked.emp.id) : null;
        if (!target && matchedFaces.length) {
            const sticky = matchedFaces.find(f => f.emp.id === lastPrimaryId);
            const biggest = matchedFaces.reduce((a, b) => (b.box.width * b.box.height > a.box.width * a.box.height ? b : a));
            target = (sticky && biggest.box.width * biggest.box.height < sticky.box.width * sticky.box.height * 1.3) ? sticky : biggest;
        }

        if (target) {
            lastPrimaryId = target.emp.id;
            const d = target.track.data;
            const phase = d.phase === 'done' ? 'done' : (d.phase === 'checking' || d.phase === 'spoof' ? d.phase : 'holding');
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
        const key = emp.id + ':' + phase;
        if (key === lastClockKey) return;
        lastClockKey = key;

        const initial = (emp.name || '?').charAt(0).toUpperCase();
        const photo = empPhotos.get(emp.id);
        const action = hs ? hs.action : 'in';
        const cls = phase === 'done' ? 'ok' : (action === 'in' ? 'in' : 'out');

        let sub;
        if (phase === 'done') sub = I18N.t('clock_recorded', { c: confidence.toFixed(0) });
        else if (phase === 'checking') sub = I18N.t('liveness_checking');
        else if (phase === 'spoof') sub = I18N.t('liveness_failed');
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
            // 写库失败：返回 false，由调用方回退该 track 的 hold 让其重试（不影响其他人）
            toast(I18N.t('clock_fail', { msg: e.message }), 'err');
            return false;
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
        if (el.livenessToggle) el.livenessToggle.checked = !!settings.liveness;
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
        if (el.livenessToggle) {
            el.livenessToggle.addEventListener('change', () => {
                settings = tmsDB.saveSettings({ liveness: el.livenessToggle.checked });
                tracker.clear();
                lastClockDets = [];
                lastClockKey = null;
                if (settings.liveness) {
                    initAntiSpoof().catch(e => toast(I18N.t('liveness_model_fail', { msg: e.message }), 'err'));
                }
            });
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
