/**
 * FaceStorage.js
 * ---------------
 * 负责 IndexedDB 存储和 JSON 导入/导出
 * 用于保存注册进度和已注册的用户数据
 */

const DB_NAME = 'FaceRegistrationDB';
const DB_VERSION = 1;
const STORE_PROGRESS = 'registrationProgress';
const STORE_USERS = 'registeredUsers';

class FaceStorage {
    constructor() {
        this.db = null;
    }

    /**
     * 包装单个 IDB request，同时监听所属 transaction 的 abort/error，
     * 防止 QuotaExceededError 或事务中止时 Promise 永远 pending。
     */
    _req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror  = () => reject(request.error);
            const tx = request.transaction;
            if (tx) {
                tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
                tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
            }
        });
    }

    /**
     * 初始化 IndexedDB 连接
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror   = () => reject(request.error);
            // another tab holds an older version open and blocks the upgrade
            request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
            request.onsuccess = () => {
                this.db = request.result;
                console.log('FaceStorage: IndexedDB initialized');
                resolve(this);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Guard the versionchange transaction so schema failures reject
                // the Promise instead of leaving it pending indefinitely.
                const upgradeTx = event.target.transaction;
                if (upgradeTx) {
                    upgradeTx.onabort = () =>
                        reject(upgradeTx.error || new Error('IndexedDB upgrade transaction aborted'));
                    upgradeTx.onerror = () =>
                        reject(upgradeTx.error || new Error('IndexedDB upgrade transaction error'));
                }

                // 存储注册进度（断点续传）
                if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
                    db.createObjectStore(STORE_PROGRESS, { keyPath: 'id' });
                }

                // 存储已注册的用户
                if (!db.objectStoreNames.contains(STORE_USERS)) {
                    const store = db.createObjectStore(STORE_USERS, { keyPath: 'userId' });
                    store.createIndex('name', 'name', { unique: false });
                }
            };
        });
    }

    // ========== 注册进度管理 ==========

    /**
     * 保存注册进度（用于断点续传）
     */
    async saveProgress(progressData) {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_PROGRESS, 'readwrite');
        const data = { id: 'current', timestamp: Date.now(), ...progressData };
        await this._req(tx.objectStore(STORE_PROGRESS).put(data));
        return true;
    }

    /**
     * 加载注册进度
     */
    async loadProgress() {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_PROGRESS, 'readonly');
        const result = await this._req(tx.objectStore(STORE_PROGRESS).get('current'));
        return result || null;
    }

    /**
     * 清除注册进度
     */
    async clearProgress() {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_PROGRESS, 'readwrite');
        await this._req(tx.objectStore(STORE_PROGRESS).delete('current'));
        return true;
    }

    // ========== 用户数据管理 ==========

    /**
     * 保存注册用户
     */
    async saveUser(userData) {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_USERS, 'readwrite');
        const data = { ...userData, registeredAt: Date.now() };
        await this._req(tx.objectStore(STORE_USERS).put(data));
        return true;
    }

    /**
     * 获取所有已注册用户
     */
    async getAllUsers() {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_USERS, 'readonly');
        const result = await this._req(tx.objectStore(STORE_USERS).getAll());
        return result || [];
    }

    /**
     * 根据 userId 获取用户
     */
    async getUser(userId) {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_USERS, 'readonly');
        const result = await this._req(tx.objectStore(STORE_USERS).get(userId));
        return result || null;
    }

    /**
     * 删除用户
     */
    async deleteUser(userId) {
        if (!this.db) await this.init();
        const tx = this.db.transaction(STORE_USERS, 'readwrite');
        await this._req(tx.objectStore(STORE_USERS).delete(userId));
        return true;
    }

    // ========== JSON 导入/导出 ==========

    /**
     * 导出所有用户为 JSON
     */
    async exportToJSON() {
        const users = await this.getAllUsers();

        // 转换为标准格式
        const exportData = users.map(user => ({
            id: user.userId,
            name: user.name,
            descriptors: user.descriptors.map(d => Array.from(d)),
            meanDescriptor: user.meanDescriptor ? Array.from(user.meanDescriptor) : null,
            descriptorClusters: Array.isArray(user.descriptorClusters)
                ? user.descriptorClusters.map(c => Array.from(c))
                : null,
            registeredAt: user.registeredAt
        }));

        return JSON.stringify(exportData, null, 2);
    }

    /**
     * 从 JSON 导入用户
     */
    async importFromJSON(jsonString) {
        try {
            const data = JSON.parse(jsonString);

            if (!Array.isArray(data)) {
                throw new Error('Invalid format: expected array');
            }

            let imported = 0;
            let skipped = 0;
            for (const user of data) {
                // 逐条校验：缺 id 会让 IndexedDB 用 undefined 当 keyPath 污染存储；
                // descriptors 非数组会让 .map 抛错中断整批导入。坏数据跳过而非中断。
                if (!user || typeof user !== 'object') { skipped++; continue; }
                if (user.id === undefined || user.id === null || user.id === '') { skipped++; continue; }
                if (!Array.isArray(user.descriptors) || user.descriptors.length === 0) { skipped++; continue; }
                const allValid = user.descriptors.every(d => Array.isArray(d) || ArrayBuffer.isView(d));
                if (!allValid) { skipped++; continue; }

                // 多簇锚点：仅接受「数组的数组（或类型化数组）」，逐簇转 Float32Array；
                // 格式不符则置 null，匹配器会回退到 meanDescriptor（向后兼容）。
                const clusters = Array.isArray(user.descriptorClusters)
                    ? user.descriptorClusters
                        .filter(c => Array.isArray(c) || ArrayBuffer.isView(c))
                        .map(c => new Float32Array(c))
                    : null;

                await this.saveUser({
                    userId: String(user.id),
                    name: user.name != null ? String(user.name) : String(user.id),
                    descriptors: user.descriptors.map(d => new Float32Array(d)),
                    meanDescriptor: (Array.isArray(user.meanDescriptor) || ArrayBuffer.isView(user.meanDescriptor))
                        ? new Float32Array(user.meanDescriptor)
                        : null,
                    descriptorClusters: (clusters && clusters.length > 0) ? clusters : null
                });
                imported++;
            }

            return { success: true, count: imported, skipped };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * 下载 JSON 文件
     */
    async downloadJSON(filename = 'face_registrations.json') {
        const jsonData = await this.exportToJSON();
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();

        URL.revokeObjectURL(url);
    }
}

// 导出单例
const faceStorage = new FaceStorage();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FaceStorage, faceStorage };
}
