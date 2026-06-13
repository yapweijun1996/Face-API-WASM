/**
 * tms-i18n.js
 * -----------
 * 轻量 i18n：英文 / 简体中文。
 *
 * 用法：
 *  - 静态文本：在 HTML 元素上加 data-i18n="key"（设 textContent）
 *    或 data-i18n-ph="key"（设 placeholder）。
 *  - 动态文本：JS 里调用 I18N.t('key', { n: 5 }) —— 用 {n} 占位。
 *  - 语言存于 localStorage('tms_lang')，默认跟随浏览器语言。
 *  - 切换语言后会触发 I18N.onChange 回调，供 app 重渲染动态内容。
 */

const I18N = (() => {
    const DICT = {
        en: {
            tab_clock: 'Clock', tab_dashboard: 'Dashboard', tab_employees: 'Staff', tab_records: 'Records',
            emp_count: '{n} staff',
            dash_in_now: 'On duty', dash_late_today: 'Late today', dash_total_staff: 'Total staff',
            dash_whos_in: 'Currently on duty', dash_nobody_in: 'Nobody on duty right now.',
            dash_weekly_hours: 'Hours — last 7 days',

            boot_loading: 'Loading…',
            boot_backend: 'Starting WASM backend…',
            boot_models: 'Loading face models…',
            boot_warmup: 'Warming up…',
            boot_employees: 'Loading staff data…',
            boot_fail: 'Init failed: {msg} (open over HTTPS or localhost and allow the camera)',

            update_available: 'New version', update_now: 'Update now',

            clock_face_camera: 'Please face the camera…',
            clock_no_employees: 'No staff yet — enroll a face under the “Staff” tab first.',
            clock_no_match: 'No registered staff recognized',
            clock_recorded: 'Recorded · {c}% confidence',
            clock_done: 'Clocked',
            clock_confidence: '{c}% confidence',
            clock_in_btn: 'Clock In',
            clock_out_btn: 'Clock Out',
            liveness_verifying: 'AI verifying (MiniCPM-V)…',
            liveness_loading: 'Connecting to LM Studio…',
            vlm_modal_sending: 'Sending to AI for verification…',
            vlm_modal_wait: 'Confirming you are a live person — please wait',
            vlm_modal_real: 'Live person · {p}% real',
            vlm_modal_fake: 'Spoof suspected — {p}% likely fake',
            vlm_modal_unavailable: 'AI check unavailable — clocked in anyway',
            vlm_modal_error: 'AI check error — clocked in anyway',
            hold_to_in: 'Hold still to clock in…',
            hold_to_out: 'Hold still to clock out…',
            voice_in: 'Welcome, {name}',
            voice_out: 'Goodbye, {name}',
            camera_error: 'Cannot access camera: {msg}',
            clock_fail: 'Clock failed: {msg}',
            toast_clock_in: '{name} clocked in',
            toast_clock_out: '{name} clocked out',

            emp_register_title: 'Enroll new staff',
            label_name: 'Name', ph_name: 'e.g. John',
            label_dept: 'Department (optional)', ph_dept: 'e.g. Engineering',
            enroll_btn: 'Capture face & enroll',
            emp_list_title: 'Enrolled staff',
            emp_empty: 'No staff yet — enroll one above.',
            emp_meta: '{dept} · {n} frames · {date}',
            edit_staff: 'Edit staff',
            staff_updated: 'Staff “{name}” updated',
            staff_update_fail: 'Could not update staff: {msg}',
            view_registered_faces: 'View registered Face ID images',
            faces_title: 'Registered Face ID images — {name}',
            face_preview_note: 'Showing {n} saved face registration images for this staff member.',
            face_sample_label: 'Image {n}',
            face_sample_alt: 'Registered face image {n}',
            preview_photo: 'Preview captured photo',
            photo_title: 'Captured photo — {name}',
            no_photo: 'No captured photo to preview',
            delete_staff: 'Delete staff',
            emp_delete_confirm: 'Delete “{name}”? Their attendance records are kept.',
            deleted: 'Deleted',
            need_name: 'Please enter a name first',
            enroll_title: 'Enroll: {name}',
            enroll_success: 'Staff “{name}” enrolled',
            enroll_fail: 'Enroll failed: {msg}',
            cancel: 'Cancel',
            close: 'Close',
            ok: 'OK',
            save: 'Save',

            records_title: 'Attendance records',
            no_hours: 'No complete hours logged today',
            hours_prefix: 'Today — ',
            hours_item: '{name}: {h}h',
            on_duty: ' (on duty)',
            th_emp: 'Staff', th_type: 'Type', th_date: 'Date', th_time: 'Time', th_status: 'Status',
            type_in: 'In', type_out: 'Out',
            status_ontime: 'On time', status_late: 'Late', status_early: 'Early', status_overtime: 'Overtime',
            schedule_title: 'Schedule',
            work_start: 'Start time', work_end: 'End time', grace_min: 'Late grace (min)',
            records_empty: 'No attendance records yet.',
            export_csv: 'Export CSV',
            clear_records: 'Clear records',
            clear_confirm: 'Clear ALL attendance records? This cannot be undone.',
            cleared: 'Attendance records cleared',
            no_records: 'No records',
            sensitivity_title: 'Recognition sensitivity',
            threshold_label: 'Match threshold {v} (lower = stricter)',
            security_title: 'Anti-spoofing',
            liveness_label: 'AI vision liveness (MiniCPM-V via LM Studio)',
            liveness_desc: 'When on, clock-in captures ~5 webcam frames (1 fps) and sends them to a local MiniCPM-V vision model (LM Studio) which judges live-person vs spoof (photo / phone or screen / printout / mask). Frames never leave your machine (localhost). If LM Studio is unreachable, clock-in continues WITHOUT the check (fail-open). Note: stronger than a tiny texture model because it sees the whole frame (a hand holding a phone, screen bezels) — but still not certified PAD; validate on your own samples.',
            realprob_label: 'AI live-confidence threshold {v} (higher = stricter)',
            vlm_endpoint_label: 'LM Studio API base URL',
            vlm_model_label: 'Vision model id',
            liveness_engine_fail: 'LM Studio not reachable — clock-in continues without the AI check. {msg}',
            liveness_loaded: 'AI liveness ready ({caps})',
            settings_save_fail: 'Settings apply for this session only — saving failed (private mode or storage full)',
            sound_title: 'Sound',
            sound_master_label: 'Clock-in sounds',
            sound_master_desc: 'Play a tone on a successful clock-in/out; enable voice below to also speak the name.',
            voice_enable_label: 'Speak staff name',
            voice_enable_desc: 'Uses browser built-in text-to-speech (Web Speech API).',
            voice_voice_label: 'Voice',
            voice_default: 'Browser default',
            voice_test: 'Test',
            dash: '—'
        },
        zh: {
            tab_clock: '打卡', tab_dashboard: '看板', tab_employees: '员工', tab_records: '记录',
            emp_count: '{n} 名员工',
            dash_in_now: '在岗', dash_late_today: '今日迟到', dash_total_staff: '员工总数',
            dash_whos_in: '当前在岗', dash_nobody_in: '当前无人在岗。',
            dash_weekly_hours: '近 7 天工时',

            boot_loading: '加载中…',
            boot_backend: '启动 WASM 后端…',
            boot_models: '加载人脸模型…',
            boot_warmup: '预热…',
            boot_employees: '加载员工数据…',
            boot_fail: '初始化失败：{msg}（请用 HTTPS 或 localhost 打开，并允许摄像头）',

            update_available: '有新版本', update_now: '立即更新',

            clock_face_camera: '请正对镜头…',
            clock_no_employees: '还没有员工，请先到「员工」标签注册人脸。',
            clock_no_match: '未识别到已注册员工',
            clock_recorded: '已记录 · 置信度 {c}%',
            clock_done: '打卡完成',
            clock_confidence: '置信度 {c}%',
            clock_in_btn: '上班打卡',
            clock_out_btn: '下班打卡',
            liveness_verifying: 'AI 核验中（MiniCPM-V）…',
            liveness_loading: '正在连接 LM Studio…',
            vlm_modal_sending: '正在发送给 AI 核验…',
            vlm_modal_wait: '正在确认你是真人，请稍候',
            vlm_modal_real: '真人 · {p}% 真',
            vlm_modal_fake: '疑似伪造 — {p}% 像假',
            vlm_modal_unavailable: '核验不可用 — 已照常打卡',
            vlm_modal_error: 'AI 核验异常 — 已照常打卡',
            hold_to_in: '保持对准，正在上班打卡…',
            hold_to_out: '保持对准，正在下班打卡…',
            voice_in: '欢迎，{name}',
            voice_out: '再见，{name}',
            camera_error: '无法访问摄像头：{msg}',
            clock_fail: '打卡失败：{msg}',
            toast_clock_in: '{name} 上班打卡成功',
            toast_clock_out: '{name} 下班打卡成功',

            emp_register_title: '注册新员工',
            label_name: '姓名', ph_name: '如：张三',
            label_dept: '部门（选填）', ph_dept: '如：研发部',
            enroll_btn: '采集人脸并注册',
            emp_list_title: '已注册员工',
            emp_empty: '还没有员工，先注册一个吧。',
            emp_meta: '{dept} · {n} 帧 · {date}',
            edit_staff: '编辑员工',
            staff_updated: '员工「{name}」已更新',
            staff_update_fail: '员工更新失败：{msg}',
            view_registered_faces: '查看已注册 Face ID 图片',
            faces_title: '已注册 Face ID 图片 — {name}',
            face_preview_note: '正在显示此员工保存的 {n} 张人脸注册图片。',
            face_sample_label: '图片 {n}',
            face_sample_alt: '已注册人脸图片 {n}',
            preview_photo: '预览采集照片',
            photo_title: '采集照片 — {name}',
            no_photo: '没有可预览的采集照片',
            delete_staff: '删除员工',
            emp_delete_confirm: '删除员工「{name}」？其考勤记录会保留。',
            deleted: '已删除',
            need_name: '请先填写姓名',
            enroll_title: '注册：{name}',
            enroll_success: '员工「{name}」注册成功',
            enroll_fail: '注册失败：{msg}',
            cancel: '取消',
            close: '关闭',
            ok: '确定',
            save: '保存',

            records_title: '考勤记录',
            no_hours: '今日暂无完整工时记录',
            hours_prefix: '今日工时 — ',
            hours_item: '{name}: {h}h',
            on_duty: '（在岗）',
            th_emp: '员工', th_type: '类型', th_date: '日期', th_time: '时间', th_status: '状态',
            type_in: '上班', type_out: '下班',
            status_ontime: '正常', status_late: '迟到', status_early: '早退', status_overtime: '加班',
            schedule_title: '排班',
            work_start: '上班时间', work_end: '下班时间', grace_min: '迟到宽限（分钟）',
            records_empty: '暂无打卡记录。',
            export_csv: '导出 CSV',
            clear_records: '清空记录',
            clear_confirm: '清空所有考勤记录？此操作不可恢复。',
            cleared: '已清空考勤记录',
            no_records: '暂无记录',
            sensitivity_title: '识别灵敏度',
            threshold_label: '匹配阈值 {v}（越小越严格）',
            security_title: '防伪',
            liveness_label: 'AI 视觉活体核验（MiniCPM-V via LM Studio）',
            liveness_desc: '开启后，打卡会抓约 5 张摄像头画面（1fps）发给本机的 MiniCPM-V 视觉模型（LM Studio），由它判断「真人在场 vs 伪造（照片/手机或屏幕/打印件/面具）」。画面只发往本机 localhost、不出网。若 LM Studio 不可达，则打卡继续但跳过核验（失败放行）。说明：因为看的是整帧（能发现举着手机、屏幕边框），比小型纹理模型强，但仍非认证级 PAD——请用你自己的样本验证。',
            realprob_label: 'AI 真人置信度阈值 {v}（越大越严格）',
            vlm_endpoint_label: 'LM Studio API 地址',
            vlm_model_label: '视觉模型 id',
            liveness_engine_fail: 'LM Studio 不可达——打卡将继续但跳过 AI 核验。{msg}',
            liveness_loaded: 'AI 活体就绪（{caps}）',
            settings_save_fail: '设置仅本次会话生效——保存失败（隐私模式或存储已满）',
            sound_title: '声音提示',
            sound_master_label: '打卡声音提示',
            sound_master_desc: '打卡成功时播放提示音；可在下方单独开启语音播报姓名。',
            voice_enable_label: '语音播报员工姓名',
            voice_enable_desc: '使用浏览器内置语音合成（Web Speech API）。',
            voice_voice_label: '语音',
            voice_default: '浏览器默认',
            voice_test: '测试',
            dash: '—'
        }
    };

    const LANG_KEY = 'tms_lang';
    const onChange = [];

    function detect() {
        // 默认强制英文；只有用户用右上角按钮手动切换过，才记住其选择。
        const saved = localStorage.getItem(LANG_KEY);
        if (saved === 'en' || saved === 'zh') return saved;
        return 'en';
    }

    let lang = detect();

    function t(key, vars) {
        let s = (DICT[lang] && DICT[lang][key]) ?? (DICT.en[key]) ?? key;
        // 用函数替换，避免值里的 $&/$`/$' 等被当成 replace 的特殊模式（例如人名含 $）。
        if (vars) for (const k in vars) s = s.replaceAll('{' + k + '}', () => String(vars[k]));
        return s;
    }

    function apply(root = document) {
        root.querySelectorAll('[data-i18n]').forEach(node => {
            node.textContent = t(node.getAttribute('data-i18n'));
        });
        root.querySelectorAll('[data-i18n-ph]').forEach(node => {
            node.setAttribute('placeholder', t(node.getAttribute('data-i18n-ph')));
        });
        document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
    }

    function setLang(next) {
        if (next !== 'en' && next !== 'zh') return;
        lang = next;
        localStorage.setItem(LANG_KEY, next);
        apply();
        onChange.forEach(fn => { try { fn(lang); } catch (e) {} });
    }

    function toggle() { setLang(lang === 'zh' ? 'en' : 'zh'); }

    return {
        t, apply, setLang, toggle,
        get lang() { return lang; },
        get other() { return lang === 'zh' ? 'EN' : '中'; },
        onChange
    };
})();
