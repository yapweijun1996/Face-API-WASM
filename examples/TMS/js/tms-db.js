/**
 * tms-db.js
 * ---------
 * TMS (Time Management System) 的本地存储层。
 *
 * 设计：
 * - IndexedDB (TMS_DB)：员工人脸数据 + 考勤打卡记录（结构化、可增长、二进制友好）
 * - localStorage (tms_settings)：少量、扁平的用户偏好（匹配阈值、打卡冷却时间等）
 *
 * 两个 store：
 *   employees   { id, name, department, descriptors[][], meanDescriptor[], enrolledAt }
 *   attendance  { recordId(auto), employeeId, employeeName, type:'in'|'out', timestamp }
 */

const TMS_DB_NAME = 'TMS_DB';
const TMS_DB_VERSION = 1;
const STORE_EMPLOYEES = 'employees';
const STORE_ATTENDANCE = 'attendance';

const SETTINGS_KEY = 'tms_settings';
const DEFAULT_SETTINGS = {
    matchThreshold: 0.32,       // 距离小于此值才认定为同一人（越小越严格）
    clockCooldownMs: 60000,     // 同一人两次打卡的最小间隔，避免连续误触发
    enrollCaptures: 12,         // 注册时采集的帧数
    workStart: '09:00',         // 上班时间
    workEnd: '18:00',           // 下班时间
    graceMin: 10,               // 迟到宽限（分钟）
    liveness: false,            // AI 视觉活体核验（MiniCPM-V via LM Studio）：默认关闭
    livenessRealProb: 0.50,     // VLM「真人置信度」放行阈值（越大越严格）；务必用真实样本校准
    vlmEndpoint: 'http://127.0.0.1:6501/v1',   // LM Studio OpenAI 兼容前缀（端口随 LM Studio 设置改）
    vlmModel: 'minicpm-v-4.6',  // 已加载的视觉模型 id（LM Studio「API Model Identifier」）
    soundEnabled: true,         // 声音提示总控：打卡提示音 + 语音播报的总开关
    speakEnabled: true,         // 子项：打卡时语音播报员工姓名（Web Speech API），受 soundEnabled 约束
    speakVoiceURI: { en: '', zh: '' }   // 按 UI 语言分槽的 voiceURI；空字符串 = 该语言用浏览器默认
};

class TmsDB {
    constructor() {
        this.db = null;
        // localStorage 持久化失败时的回调（如 Safari 隐私模式 / 配额满），
        // 由 UI 层赋值用来提示用户；不赋值则只 console.warn。
        this.onPersistError = null;
    }

    async init() {
        if (this.db) return this;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(TMS_DB_NAME, TMS_DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { this.db = req.result; resolve(this); };
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_EMPLOYEES)) {
                    db.createObjectStore(STORE_EMPLOYEES, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(STORE_ATTENDANCE)) {
                    const s = db.createObjectStore(STORE_ATTENDANCE, { keyPath: 'recordId', autoIncrement: true });
                    s.createIndex('employeeId', 'employeeId', { unique: false });
                    s.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    _tx(store, mode) {
        return this.db.transaction(store, mode).objectStore(store);
    }

    _req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            // 事务被 abort（如 QuotaExceededError）时 request 可能不 reject，
            // 监听事务 abort/error，避免 await 永久挂起。
            const tx = request.transaction;
            if (tx) {
                tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
                tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
            }
        });
    }

    // ========== 员工 ==========

    async saveEmployee(emp) {
        await this.init();
        if (!emp || !emp.id) throw new Error('employee.id required');
        // 描述符统一存 Float32Array：结构化克隆按 4 字节/元素存，
        // 比普通 number 数组（8 字节/元素 + 对象开销）省一半以上空间。
        // FaceMatcher 读取时两种形式都兼容，旧记录无需迁移。
        const toF32 = (d) => (d instanceof Float32Array ? d : new Float32Array(d));
        const data = {
            id: String(emp.id),
            name: emp.name != null ? String(emp.name) : String(emp.id),
            department: emp.department || '',
            descriptors: (emp.descriptors || []).map(toF32),
            meanDescriptor: emp.meanDescriptor ? toF32(emp.meanDescriptor) : null,
            photo: emp.photo || null,           // 注册时抓取的脸部缩略图（dataURL）
            capturedFrames: Array.isArray(emp.capturedFrames) ? emp.capturedFrames.filter(Boolean) : [],
            enrolledAt: emp.enrolledAt || Date.now()
        };
        await this._req(this._tx(STORE_EMPLOYEES, 'readwrite').put(data));
        return data;
    }

    async updateEmployeeProfile(id, patch) {
        await this.init();
        const employeeId = String(id);
        const nextName = String(patch && patch.name || '').trim();
        const nextDepartment = String(patch && patch.department || '').trim();
        if (!nextName) throw new Error('employee.name required');
        const current = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_EMPLOYEES, 'readwrite');
            const store = tx.objectStore(STORE_EMPLOYEES);
            const getReq = store.get(employeeId);
            let updated = null;
            getReq.onsuccess = () => {
                const current = getReq.result;
                if (!current) {
                    tx.abort();
                    reject(new Error('employee not found'));
                    return;
                }
                current.name = nextName;
                current.department = nextDepartment;
                updated = current;
                store.put(current);
            };
            getReq.onerror = () => reject(getReq.error);
            tx.oncomplete = () => resolve(updated);
            tx.onabort = () => {
                if (updated) reject(tx.error || new Error('IDB transaction aborted'));
            };
            tx.onerror = () => reject(tx.error || new Error('IDB transaction error'));
        });
        await this.updateAttendanceEmployeeName(employeeId, nextName);
        return current;
    }

    async updateEmployeeName(id, name) {
        const current = (await this.getAllEmployees()).find(emp => String(emp.id) === String(id));
        return this.updateEmployeeProfile(id, {
            name,
            department: current ? current.department : ''
        });
    }

    async getAllEmployees() {
        await this.init();
        return (await this._req(this._tx(STORE_EMPLOYEES, 'readonly').getAll())) || [];
    }

    async deleteEmployee(id) {
        await this.init();
        await this._req(this._tx(STORE_EMPLOYEES, 'readwrite').delete(String(id)));
        return true;
    }

    // ========== 考勤 ==========

    async addAttendance(rec) {
        await this.init();
        const data = {
            employeeId: String(rec.employeeId),
            employeeName: rec.employeeName || '',
            type: rec.type === 'out' ? 'out' : 'in',
            status: rec.status || 'ontime',     // ontime | late | early | overtime
            timestamp: rec.timestamp || Date.now()
        };
        const id = await this._req(this._tx(STORE_ATTENDANCE, 'readwrite').add(data));
        return { recordId: id, ...data };
    }

    async getAllAttendance() {
        await this.init();
        const all = (await this._req(this._tx(STORE_ATTENDANCE, 'readonly').getAll())) || [];
        return all.sort((a, b) => b.timestamp - a.timestamp);
    }

    /** 某员工最近一条打卡记录（用于判断下一次是 in 还是 out）
     *  用 employeeId 索引 + 游标只取最新一条，避免每次都 getAll+排序整个库。 */
    async getLastAttendance(employeeId) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_ATTENDANCE, 'readonly');
            const req = tx.objectStore(STORE_ATTENDANCE).index('employeeId')
                .openCursor(IDBKeyRange.only(String(employeeId)), 'prev');
            req.onsuccess = () => {
                const cur = req.result;
                // 同一 employeeId 下索引按主键(recordId 自增)升序，prev 取到的是
                // 最大 recordId，即最近插入的一条。
                resolve(cur ? cur.value : null);
            };
            req.onerror = () => reject(req.error);
            // 与 _req 保持一致：事务被 abort 时（如 QuotaExceededError）req.onerror
            // 不一定触发，监听 tx.onabort 确保 Promise 不永久 pending。
            tx.onabort = () => reject(tx.error || new Error('IDB transaction aborted'));
            tx.onerror = () => reject(tx.error || new Error('IDB transaction error'));
        });
    }

    async clearAttendance() {
        await this.init();
        await this._req(this._tx(STORE_ATTENDANCE, 'readwrite').clear());
        return true;
    }

    async updateAttendanceEmployeeName(employeeId, employeeName) {
        await this.init();
        const id = String(employeeId);
        const name = String(employeeName || '');
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_ATTENDANCE, 'readwrite');
            const store = tx.objectStore(STORE_ATTENDANCE);
            const req = store.index('employeeId').openCursor(IDBKeyRange.only(id));
            req.onsuccess = () => {
                const cur = req.result;
                if (!cur) return;
                const rec = cur.value;
                rec.employeeName = name;
                cur.update(rec);
                cur.continue();
            };
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => resolve(true);
            tx.onabort = () => reject(tx.error || new Error('IDB transaction aborted'));
            tx.onerror = () => reject(tx.error || new Error('IDB transaction error'));
        });
    }

    // ========== 设置 (localStorage) ==========

    getSettings() {
        try {
            const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            return { ...DEFAULT_SETTINGS, ...raw };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    saveSettings(patch) {
        const next = { ...this.getSettings(), ...patch };
        try {
            // Safari 隐私模式 / 配额满时 setItem 会同步抛错，吞掉避免调用方崩溃。
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch (e) {
            console.warn('TMS: failed to persist settings', e);
            if (typeof this.onPersistError === 'function') this.onPersistError(e);
        }
        return next;
    }
}

const tmsDB = new TmsDB();
