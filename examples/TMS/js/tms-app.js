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
    let regManager = null;
    let appMode = 'idle';            // 'idle' | 'clock' | 'enroll'
    let stream = null;
    let activeVideo = null;
    let loopHandle = null;
    let detecting = false;

    // 打卡防抖：记录每个员工最近一次成功打卡时间，冷却期内忽略
    const cooldown = new Map();
    let lastClockKey = null;          // 当前 clock 面板展示的员工，避免重复渲染

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

        const loop = async (ts) => {
            if (!detecting || !activeVideo) return;
            // 节流：约每 200ms 跑一次，省手机电量
            if (!busy && ts - lastRun > 200 && activeVideo.readyState === activeVideo.HAVE_ENOUGH_DATA) {
                busy = true; lastRun = ts;
                try {
                    const det = await faceapi
                        .detectSingleFace(activeVideo, detectorOptions())
                        .withFaceLandmarks()
                        .withFaceDescriptor();

                    if (ctx) drawBox(ctx, overlay, det);

                    if (det) {
                        if (appMode === 'clock') handleClockFrame(det);
                        else if (appMode === 'enroll') handleEnrollFrame(det);
                    } else if (appMode === 'clock') {
                        showClockIdle();
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

    function drawBox(ctx, overlay, det) {
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (!det) return;
        const b = det.detection.box;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 3;
        ctx.strokeRect(b.x, b.y, b.width, b.height);
    }

    // ============================================================
    // 打卡识别
    // ============================================================
    async function handleClockFrame(det) {
        const result = matcher.findBestMatch(det.descriptor);
        if (result.status !== 'matched') {
            showClockNoMatch();
            return;
        }
        const emp = result.user;
        // 冷却中：刚打过卡，提示已记录
        const last = cooldown.get(emp.id);
        if (last && Date.now() - last < settings.clockCooldownMs) {
            renderClockCard(emp, result.confidence, 'done');
            return;
        }
        const lastRec = await tmsDB.getLastAttendance(emp.id);
        const nextType = lastRec && lastRec.type === 'in' ? 'out' : 'in';
        renderClockCard(emp, result.confidence, nextType);
    }

    function renderClockCard(emp, confidence, action) {
        const key = emp.id + ':' + action;
        if (key === lastClockKey) return;   // 避免每帧重渲染
        lastClockKey = key;

        const initial = (emp.name || '?').charAt(0).toUpperCase();
        if (action === 'done') {
            el.clockCard.innerHTML = '';
            el.clockCard.append(
                buildAvatar(initial, 'ok'),
                buildText(emp.name, I18N.t('clock_recorded', { c: confidence.toFixed(0) })),
            );
            const badge = document.createElement('div');
            badge.className = 'clock-badge ok';
            badge.textContent = I18N.t('clock_done');
            el.clockCard.appendChild(badge);
            el.clockCard.className = 'clock-card show';
            el.clockHint.textContent = '';
            return;
        }

        el.clockCard.innerHTML = '';
        el.clockCard.append(
            buildAvatar(initial, action === 'in' ? 'in' : 'out'),
            buildText(emp.name, I18N.t('clock_confidence', { c: confidence.toFixed(0) }))
        );
        const btn = document.createElement('button');
        btn.className = 'clock-action ' + action;
        btn.textContent = action === 'in' ? I18N.t('clock_in_btn') : I18N.t('clock_out_btn');
        btn.onclick = () => doClock(emp, action);
        el.clockCard.appendChild(btn);
        el.clockCard.className = 'clock-card show';
        el.clockHint.textContent = '';
    }

    function buildAvatar(initial, cls) {
        const a = document.createElement('div');
        a.className = 'clock-avatar ' + cls;
        a.textContent = initial;
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
        await tmsDB.addAttendance({ employeeId: emp.id, employeeName: emp.name, type });
        cooldown.set(emp.id, Date.now());
        lastClockKey = null;
        toast(I18N.t(type === 'in' ? 'toast_clock_in' : 'toast_clock_out', { name: emp.name }), 'ok');
        renderClockCard(emp, 100, 'done');
        await renderRecords();
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
            await tmsDB.saveEmployee({
                id: data.id,
                name: data.name,
                department: el.empDept.value.trim(),
                descriptors: data.descriptors,
                meanDescriptor: data.meanDescriptor,
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
            av.textContent = (emp.name || '?').charAt(0).toUpperCase();

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
