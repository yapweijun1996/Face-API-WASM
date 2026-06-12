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
     * 初始化 IndexedDB 连接
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                console.log('FaceStorage: IndexedDB initialized');
                resolve(this);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

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

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_PROGRESS, 'readwrite');
            const store = tx.objectStore(STORE_PROGRESS);

            const data = {
                id: 'current',
                timestamp: Date.now(),
                ...progressData
            };

            const request = store.put(data);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 加载注册进度
     */
    async loadProgress() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_PROGRESS, 'readonly');
            const store = tx.objectStore(STORE_PROGRESS);
            const request = store.get('current');

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 清除注册进度
     */
    async clearProgress() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_PROGRESS, 'readwrite');
            const store = tx.objectStore(STORE_PROGRESS);
            const request = store.delete('current');

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    // ========== 用户数据管理 ==========

    /**
     * 保存注册用户
     */
    async saveUser(userData) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_USERS, 'readwrite');
            const store = tx.objectStore(STORE_USERS);

            const data = {
                ...userData,
                registeredAt: Date.now()
            };

            const request = store.put(data);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 获取所有已注册用户
     */
    async getAllUsers() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_USERS, 'readonly');
            const store = tx.objectStore(STORE_USERS);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 根据 userId 获取用户
     */
    async getUser(userId) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_USERS, 'readonly');
            const store = tx.objectStore(STORE_USERS);
            const request = store.get(userId);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 删除用户
     */
    async deleteUser(userId) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_USERS, 'readwrite');
            const store = tx.objectStore(STORE_USERS);
            const request = store.delete(userId);

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
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

                await this.saveUser({
                    userId: String(user.id),
                    name: user.name != null ? String(user.name) : String(user.id),
                    descriptors: user.descriptors.map(d => new Float32Array(d)),
                    meanDescriptor: (Array.isArray(user.meanDescriptor) || ArrayBuffer.isView(user.meanDescriptor))
                        ? new Float32Array(user.meanDescriptor)
                        : null
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
