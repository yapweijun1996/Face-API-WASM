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
            tab_clock: 'Clock', tab_employees: 'Staff', tab_records: 'Records',
            emp_count: '{n} staff',

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
            clock_done: '✓ Clocked',
            clock_confidence: '{c}% confidence',
            clock_in_btn: '🟢 Clock In',
            clock_out_btn: '🔴 Clock Out',
            camera_error: 'Cannot access camera: {msg}',
            toast_clock_in: '{name} clocked in',
            toast_clock_out: '{name} clocked out',

            emp_register_title: '➕ Enroll new staff',
            label_name: 'Name', ph_name: 'e.g. John',
            label_dept: 'Department (optional)', ph_dept: 'e.g. Engineering',
            enroll_btn: '📸 Capture face & enroll',
            emp_list_title: '👥 Enrolled staff',
            emp_empty: 'No staff yet — enroll one above.',
            emp_meta: '{dept} · {n} frames · {date}',
            emp_delete_confirm: 'Delete “{name}”? Their attendance records are kept.',
            deleted: 'Deleted',
            need_name: 'Please enter a name first',
            enroll_title: 'Enroll: {name}',
            enroll_success: 'Staff “{name}” enrolled',
            enroll_fail: 'Enroll failed: {msg}',
            cancel: 'Cancel',

            records_title: '📊 Attendance records',
            no_hours: 'No complete hours logged today',
            hours_prefix: 'Today — ',
            hours_item: '{name}: {h}h',
            on_duty: ' (on duty)',
            th_emp: 'Staff', th_type: 'Type', th_date: 'Date', th_time: 'Time',
            type_in: '🟢 In', type_out: '🔴 Out',
            records_empty: 'No attendance records yet.',
            export_csv: '⬇ Export CSV',
            clear_records: 'Clear records',
            clear_confirm: 'Clear ALL attendance records? This cannot be undone.',
            cleared: 'Attendance records cleared',
            no_records: 'No records',
            sensitivity_title: '⚙️ Recognition sensitivity',
            threshold_label: 'Match threshold {v} (lower = stricter)',
            dash: '—'
        },
        zh: {
            tab_clock: '打卡', tab_employees: '员工', tab_records: '记录',
            emp_count: '{n} 名员工',

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
            clock_done: '✓ 打卡完成',
            clock_confidence: '置信度 {c}%',
            clock_in_btn: '🟢 上班打卡 Clock In',
            clock_out_btn: '🔴 下班打卡 Clock Out',
            camera_error: '无法访问摄像头：{msg}',
            toast_clock_in: '{name} 上班打卡成功',
            toast_clock_out: '{name} 下班打卡成功',

            emp_register_title: '➕ 注册新员工',
            label_name: '姓名', ph_name: '如：张三',
            label_dept: '部门（选填）', ph_dept: '如：研发部',
            enroll_btn: '📸 采集人脸并注册',
            emp_list_title: '👥 已注册员工',
            emp_empty: '还没有员工，先注册一个吧。',
            emp_meta: '{dept} · {n} 帧 · {date}',
            emp_delete_confirm: '删除员工「{name}」？其考勤记录会保留。',
            deleted: '已删除',
            need_name: '请先填写姓名',
            enroll_title: '注册：{name}',
            enroll_success: '员工「{name}」注册成功',
            enroll_fail: '注册失败：{msg}',
            cancel: '取消',

            records_title: '📊 考勤记录',
            no_hours: '今日暂无完整工时记录',
            hours_prefix: '今日工时 — ',
            hours_item: '{name}: {h}h',
            on_duty: '（在岗）',
            th_emp: '员工', th_type: '类型', th_date: '日期', th_time: '时间',
            type_in: '🟢 上班', type_out: '🔴 下班',
            records_empty: '暂无打卡记录。',
            export_csv: '⬇ 导出 CSV',
            clear_records: '清空记录',
            clear_confirm: '清空所有考勤记录？此操作不可恢复。',
            cleared: '已清空考勤记录',
            no_records: '暂无记录',
            sensitivity_title: '⚙️ 识别灵敏度',
            threshold_label: '匹配阈值 {v}（越小越严格）',
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
        if (vars) for (const k in vars) s = s.replaceAll('{' + k + '}', vars[k]);
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
