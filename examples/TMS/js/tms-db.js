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
        });
    }

    // ========== 员工 ==========

    async saveEmployee(emp) {
        await this.init();
        if (!emp || !emp.id) throw new Error('employee.id required');
        const data = {
            id: String(emp.id),
            name: emp.name != null ? String(emp.name) : String(emp.id),
            department: emp.department || '',
            descriptors: emp.descriptors || [],
            meanDescriptor: emp.meanDescriptor || null,
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

    /** 某员工最近一条打卡记录（用于判断下一次是 in 还是 out） */
    async getLastAttendance(employeeId) {
        const all = await this.getAllAttendance();
        return all.find(r => r.employeeId === String(employeeId)) || null;
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
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        return next;
    }
}

const tmsDB = new TmsDB();
