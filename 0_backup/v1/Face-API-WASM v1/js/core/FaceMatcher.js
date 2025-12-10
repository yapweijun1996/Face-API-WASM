/**
 * FaceMatcher.js
 * ---------------
 * 人脸匹配器 - 用于 1:N 人脸验证
 * 
 * 功能：
 * - 加载已注册的用户数据
 * - 实时比对人脸特征
 * - 返回最佳匹配结果
 */

// 匹配结果状态
const MatchResult = {
    MATCHED: 'matched',
    NO_MATCH: 'no_match',
    UNKNOWN: 'unknown'
};

class FaceMatcher {
    constructor(config = {}) {
        this.config = {
            // 匹配阈值：距离小于此值认为是同一人
            matchThreshold: config.matchThreshold || 0.6,

            // 高置信度阈值：距离小于此值认为是高置信度匹配
            highConfidenceThreshold: config.highConfidenceThreshold || 0.4,

            // 是否使用平均特征向量（通常更准确）
            useMeanDescriptor: config.useMeanDescriptor !== false,

            ...config
        };

        // 已注册的用户数据
        this.registeredUsers = [];

        // 扁平化的特征向量数组（用于快速匹配）
        this.descriptors = [];
        this.descriptorToUser = []; // 每个 descriptor 对应的用户索引

        // 统计信息
        this.stats = {
            totalMatches: 0,
            successfulMatches: 0,
            lastMatchTime: 0
        };
    }

    // ========== 数据加载 ==========

    /**
     * 从 FaceStorage 加载用户数据
     */
    async loadFromStorage(storage) {
        try {
            const users = await storage.getAllUsers();
            this._processUsers(users.map(u => ({
                id: u.userId,
                name: u.name,
                descriptors: u.descriptors,
                meanDescriptor: u.meanDescriptor
            })));
            console.log(`FaceMatcher: Loaded ${this.registeredUsers.length} users from storage`);
            return { success: true, count: this.registeredUsers.length };
        } catch (error) {
            console.error('FaceMatcher: Failed to load from storage', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 从 JSON 字符串加载用户数据
     */
    loadFromJSON(jsonString) {
        try {
            const data = JSON.parse(jsonString);

            if (!Array.isArray(data)) {
                throw new Error('Invalid format: expected array');
            }

            this._processUsers(data);
            console.log(`FaceMatcher: Loaded ${this.registeredUsers.length} users from JSON`);
            return { success: true, count: this.registeredUsers.length };
        } catch (error) {
            console.error('FaceMatcher: Failed to load from JSON', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 从文件加载用户数据
     */
    async loadFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const result = this.loadFromJSON(e.target.result);
                resolve(result);
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    /**
     * 处理用户数据，构建匹配索引
     */
    _processUsers(users) {
        this.registeredUsers = [];
        this.descriptors = [];
        this.descriptorToUser = [];

        users.forEach((user, userIndex) => {
            // 验证用户数据
            if (!user.id || !user.descriptors || !Array.isArray(user.descriptors)) {
                console.warn(`FaceMatcher: Skipping invalid user at index ${userIndex}`);
                return;
            }

            // 存储用户信息
            this.registeredUsers.push({
                id: user.id,
                name: user.name || user.id,
                descriptorCount: user.descriptors.length,
                hasMeanDescriptor: !!user.meanDescriptor
            });

            const currentUserIndex = this.registeredUsers.length - 1;

            // 如果有平均特征向量且配置启用，优先使用
            if (this.config.useMeanDescriptor && user.meanDescriptor) {
                const desc = user.meanDescriptor instanceof Float32Array
                    ? user.meanDescriptor
                    : new Float32Array(user.meanDescriptor);
                this.descriptors.push(desc);
                this.descriptorToUser.push(currentUserIndex);
            } else {
                // 使用所有特征向量
                user.descriptors.forEach(desc => {
                    const floatDesc = desc instanceof Float32Array
                        ? desc
                        : new Float32Array(desc);
                    this.descriptors.push(floatDesc);
                    this.descriptorToUser.push(currentUserIndex);
                });
            }
        });

        console.log(`FaceMatcher: Indexed ${this.descriptors.length} descriptors from ${this.registeredUsers.length} users`);
    }

    // ========== 人脸匹配 ==========

    /**
     * 查找最佳匹配
     * @param {Float32Array} queryDescriptor - 待匹配的特征向量
     * @returns {Object} 匹配结果
     */
    findBestMatch(queryDescriptor) {
        if (!queryDescriptor || this.descriptors.length === 0) {
            return {
                status: MatchResult.UNKNOWN,
                user: null,
                distance: Infinity,
                confidence: 0
            };
        }

        const startTime = performance.now();

        let bestDistance = Infinity;
        let bestUserIndex = -1;

        // 遍历所有已注册的特征向量
        for (let i = 0; i < this.descriptors.length; i++) {
            const distance = this._euclideanDistance(queryDescriptor, this.descriptors[i]);

            if (distance < bestDistance) {
                bestDistance = distance;
                bestUserIndex = this.descriptorToUser[i];
            }
        }

        const matchTime = performance.now() - startTime;
        this.stats.lastMatchTime = matchTime;
        this.stats.totalMatches++;

        // 判断是否匹配
        if (bestDistance < this.config.matchThreshold && bestUserIndex >= 0) {
            const user = this.registeredUsers[bestUserIndex];
            const confidence = this._distanceToConfidence(bestDistance);

            this.stats.successfulMatches++;

            return {
                status: MatchResult.MATCHED,
                user: {
                    id: user.id,
                    name: user.name
                },
                distance: bestDistance,
                confidence: confidence,
                isHighConfidence: bestDistance < this.config.highConfidenceThreshold,
                matchTime: matchTime
            };
        }

        return {
            status: MatchResult.NO_MATCH,
            user: null,
            distance: bestDistance,
            confidence: 0,
            matchTime: matchTime
        };
    }

    /**
     * 查找所有可能的匹配（按距离排序）
     * @param {Float32Array} queryDescriptor - 待匹配的特征向量
     * @param {number} topK - 返回前 K 个结果
     * @returns {Array} 匹配结果数组
     */
    findTopMatches(queryDescriptor, topK = 3) {
        if (!queryDescriptor || this.descriptors.length === 0) {
            return [];
        }

        // 计算所有距离
        const distances = [];
        const userDistances = new Map(); // 每个用户的最佳距离

        for (let i = 0; i < this.descriptors.length; i++) {
            const distance = this._euclideanDistance(queryDescriptor, this.descriptors[i]);
            const userIndex = this.descriptorToUser[i];

            if (!userDistances.has(userIndex) || distance < userDistances.get(userIndex)) {
                userDistances.set(userIndex, distance);
            }
        }

        // 转换为数组并排序
        const results = [];
        userDistances.forEach((distance, userIndex) => {
            const user = this.registeredUsers[userIndex];
            results.push({
                user: { id: user.id, name: user.name },
                distance: distance,
                confidence: this._distanceToConfidence(distance),
                isMatch: distance < this.config.matchThreshold
            });
        });

        results.sort((a, b) => a.distance - b.distance);
        return results.slice(0, topK);
    }

    // ========== 工具方法 ==========

    /**
     * 欧几里得距离
     */
    _euclideanDistance(a, b) {
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            const diff = a[i] - b[i];
            sum += diff * diff;
        }
        return Math.sqrt(sum);
    }

    /**
     * 将距离转换为置信度百分比
     * 距离越小，置信度越高
     */
    _distanceToConfidence(distance) {
        // 使用指数衰减：distance=0 → 100%, distance=threshold → ~37%
        const confidence = Math.exp(-distance / this.config.matchThreshold) * 100;
        return Math.min(100, Math.max(0, confidence));
    }

    // ========== 状态查询 ==========

    /**
     * 获取已注册用户列表
     */
    getRegisteredUsers() {
        return this.registeredUsers.map(u => ({
            id: u.id,
            name: u.name
        }));
    }

    /**
     * 获取用户数量
     */
    getUserCount() {
        return this.registeredUsers.length;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            ...this.stats,
            userCount: this.registeredUsers.length,
            descriptorCount: this.descriptors.length,
            matchRate: this.stats.totalMatches > 0
                ? (this.stats.successfulMatches / this.stats.totalMatches * 100).toFixed(1) + '%'
                : 'N/A'
        };
    }

    /**
     * 检查是否已加载用户数据
     */
    isReady() {
        return this.registeredUsers.length > 0;
    }

    /**
     * 清除所有数据
     */
    clear() {
        this.registeredUsers = [];
        this.descriptors = [];
        this.descriptorToUser = [];
        this.stats = {
            totalMatches: 0,
            successfulMatches: 0,
            lastMatchTime: 0
        };
    }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FaceMatcher, MatchResult };
}
