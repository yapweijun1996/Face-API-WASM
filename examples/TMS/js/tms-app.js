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
    let lastClockDet = null;          // 最近一帧 clock 检测结果（用于逐帧画环）
    let holdState = null;             // { id, name, action, startTs, blinked, conf }

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
            'thresholdInput', 'thresholdVal', 'thresholdLabel'
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
    }

    // ============================================================
    // 统一检测循环（按 appMode 分流）
    // ============================================================
    function startLoop(overlay) {
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
                    const det = await faceapi
                        .detectSingleFace(activeVideo, detectorOptions())
                        .withFaceLandmarks()
                        .withFaceDescriptor();

                    if (appMode === 'clock') {
                        lastClockDet = det || null;
                        if (det) handleClockFrame(det);
                        else { holdState = null; showClockIdle(); }
                    } else if (appMode === 'enroll') {
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
    function drawClockOverlay(ctx, overlay) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        const det = lastClockDet;
        if (!det) return;

        const b = det.detection.box;
        const x = overlay.width - b.x - b.width;     // 翻转 x 对齐镜像视频
        const y = b.y;

        const inCooldown = holdState && holdState.phase === 'done';
        const color = inCooldown ? '#22c55e' : (holdState ? (holdState.action === 'in' ? '#22c55e' : '#f43f5e') : '#22d3ee');

        // 人脸框
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, b.width, b.height);

        if (!holdState) return;

        // 姓名标签（canvas 未镜像，文字可正常阅读）
        const label = holdState.name;
        ctx.font = '600 18px -apple-system, "PingFang SC", sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(15,23,42,.85)';
        ctx.fillRect(x, y - 30, tw + 16, 26);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 8, y - 11);

        // 倒计时环（人脸右上角）
        const cx = x + b.width + 4, cy = y + 18, rad = 16;
        let prog = 0, hint = '';
        if (holdState.phase === 'done') { prog = 1; }
        else if (!holdState.blinked) { prog = 0.15; hint = I18N.t('liveness_blink'); }
        else {
            prog = Math.min(1, (performance.now() - holdState.startTs) / HOLD_MS);
            hint = I18N.t(holdState.action === 'in' ? 'clock_in_btn' : 'clock_out_btn');
        }
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 4; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
        if (holdState.phase === 'done') {
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
    // 打卡识别
    // ============================================================
    async function handleClockFrame(det) {
        const result = matcher.findBestMatch(det.descriptor);
        if (result.status !== 'matched') {
            holdState = null;
            showClockNoMatch();
            return;
        }
        const emp = result.user;

        // 冷却中：刚打过卡
        const last = cooldown.get(emp.id);
        if (last && Date.now() - last < settings.clockCooldownMs) {
            holdState = { id: emp.id, name: emp.name, action: 'in', phase: 'done', blinked: true, startTs: 0 };
            renderClockStatus(emp, result.confidence, 'done');
            return;
        }

        // 维护 hold：换人则重置计时
        if (!holdState || holdState.id !== emp.id || holdState.phase === 'done') {
            const lastRec = await tmsDB.getLastAttendance(emp.id);
            const nextType = lastRec && lastRec.type === 'in' ? 'out' : 'in';
            holdState = { id: emp.id, name: emp.name, action: nextType, startTs: performance.now(), blinked: false, phase: 'hold' };
        }

        // 活体：检测到一次闭眼即视为通过；通过后重置计时，开始正式倒计时
        if (!holdState.blinked && blinkNow(det)) {
            holdState.blinked = true;
            holdState.startTs = performance.now();
        }

        renderClockStatus(emp, result.confidence, holdState.blinked ? 'holding' : 'blink');

        // 满足：已眨眼 + 保持足够时长 → 自动打卡
        if (holdState.blinked && performance.now() - holdState.startTs >= HOLD_MS) {
            const action = holdState.action;
            holdState.phase = 'done';
            await doClock(emp, action);
        }
    }

    function renderClockStatus(emp, confidence, phase) {
        const key = emp.id + ':' + phase;
        if (key === lastClockKey) return;
        lastClockKey = key;

        const initial = (emp.name || '?').charAt(0).toUpperCase();
        const photo = empPhotos.get(emp.id);
        const cls = phase === 'done' ? 'ok' : (holdState && holdState.action === 'in' ? 'in' : 'out');

        let sub;
        if (phase === 'done') sub = I18N.t('clock_recorded', { c: confidence.toFixed(0) });
        else if (phase === 'blink') sub = I18N.t('liveness_blink');
        else sub = I18N.t(holdState && holdState.action === 'in' ? 'hold_to_in' : 'hold_to_out');

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

    async function doClock(emp, type) {
        cooldown.set(emp.id, Date.now());   // 先置冷却，挡住下一帧重入
        lastClockKey = null;
        await tmsDB.addAttendance({ employeeId: emp.id, employeeName: emp.name, type });
        beep(type === 'in' ? 880 : 520);
        speak(I18N.t(type === 'in' ? 'voice_in' : 'voice_out', { name: emp.name }));
        toast(I18N.t(type === 'in' ? 'toast_clock_in' : 'toast_clock_out', { name: emp.name }), 'ok');
        renderClockStatus(emp, 100, 'done');
        await renderRecords();
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
                n: emp.descriptors.length,
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
        const s = String(v ?? '');
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
        }
    }

    // ============================================================
    // 设置
    // ============================================================
    function applySettingsToUi() {
        if (!el.thresholdInput) return;
        el.thresholdInput.value = settings.matchThreshold;
        el.thresholdLabel.textContent = I18N.t('threshold_label', { v: settings.matchThreshold.toFixed(2) });
    }

    // ============================================================
    // UI 事件绑定
    // ============================================================
    function wireUi() {
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
