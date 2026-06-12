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
    matchThreshold: 0.5,        // 距离小于此值才认定为同一人（越小越严格）
    clockCooldownMs: 60000,     // 同一人两次打卡的最小间隔，避免连续误触发
    enrollCaptures: 12,         // 注册时采集的帧数
    workStart: '09:00',         // 上班时间
    workEnd: '18:00',           // 下班时间
    graceMin: 10                // 迟到宽限（分钟）
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
            enrolledAt: emp.enrolledAt || Date.now()
        };
        await this._req(this._tx(STORE_EMPLOYEES, 'readwrite').put(data));
        return data;
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
            const idx = this._tx(STORE_ATTENDANCE, 'readonly').index('employeeId');
            const req = idx.openCursor(IDBKeyRange.only(String(employeeId)), 'prev');
            req.onsuccess = () => {
                const cur = req.result;
                // 同一 employeeId 下索引按主键(recordId 自增)升序，prev 取到的是
                // 最大 recordId，即最近插入的一条。
                resolve(cur ? cur.value : null);
            };
            req.onerror = () => reject(req.error);
        });
    }

    async clearAttendance() {
        await this.init();
        await this._req(this._tx(STORE_ATTENDANCE, 'readwrite').clear());
        return true;
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
