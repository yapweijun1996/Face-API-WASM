/**
 * FaceRegistrationManager.js
 * ---------------------------
 * 人脸注册管理器 - 状态机实现
 * 
 * 状态流程：
 * IDLE -> COLLECTING -> COMPUTING -> SAVED
 *   ↑__________________________|
 *   (restart)
 */

// ========== 注册状态枚举 ==========
const RegistrationState = {
    IDLE: 'idle',           // 空闲状态
    COLLECTING: 'collecting', // 正在采集人脸
    COMPUTING: 'computing',   // 正在计算特征值
    SAVED: 'saved',          // 已保存完成
    ERROR: 'error'           // 错误状态
};

// ========== 配置常量 ==========
const DEFAULT_CONFIG = {
    maxCaptures: 20,                    // 需要采集的帧数
    captureInterval: 500,               // 每次采集间隔（毫秒）
    similarityThreshold: 0.15,          // 最小差异阈值（避免重复帧）
    qualityScoreThreshold: 0.5,         // 人脸置信度阈值
    minFaceAreaRatio: 0.05,             // 人脸最小面积比例（相对于画面）
    consistencyThreshold: 0.4,          // 同一人判定阈值
    autoSaveProgress: true              // 是否自动保存进度到 IndexedDB
};

class FaceRegistrationManager {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // 状态
        this.state = RegistrationState.IDLE;

        // 用户信息
        this.userId = '';
        this.userName = '';

        // 采集的数据
        this.descriptors = [];          // 特征向量数组
        this.capturedFrames = [];       // 缩略图 base64

        // 计算结果
        this.meanDescriptor = null;

        // 回调函数
        this.onStateChange = null;
        this.onProgress = null;
        this.onCapture = null;
        this.onComplete = null;
        this.onError = null;

        // 内部状态
        this._lastCaptureTime = 0;
        this._storage = null;
    }

    // ========== 初始化 ==========

    /**
     * 初始化管理器（可选：连接 IndexedDB）
     */
    async init(storage = null) {
        this._storage = storage;

        if (this._storage && this.config.autoSaveProgress) {
            await this._loadProgress();
        }

        console.log('FaceRegistrationManager initialized');
        return this;
    }

    // ========== 状态机控制 ==========

    /**
     * 开始注册流程
     */
    start(userId, userName) {
        if (this.state !== RegistrationState.IDLE && this.state !== RegistrationState.SAVED) {
            console.warn('Cannot start: already in progress');
            return false;
        }

        this.userId = userId;
        this.userName = userName;
        this.descriptors = [];
        this.capturedFrames = [];
        this.meanDescriptor = null;

        this._setState(RegistrationState.COLLECTING);
        return true;
    }

    /**
     * 暂停采集
     */
    pause() {
        // 保持状态，只是暂停处理
        console.log('Registration paused');
    }

    /**
     * 继续采集
     */
    resume() {
        console.log('Registration resumed');
    }

    /**
     * 取消注册
     */
    cancel() {
        this.descriptors = [];
        this.capturedFrames = [];
        this.meanDescriptor = null;

        if (this._storage) {
            this._storage.clearProgress();
        }

        this._setState(RegistrationState.IDLE);
    }

    /**
     * 重新开始
     */
    restart() {
        this.cancel();
        this.start(this.userId, this.userName);
    }

    // ========== 核心处理逻辑 ==========

    /**
     * 处理检测到的人脸
     * @param {Object} detection - face-api.js 的检测结果
     * @param {ImageData} frameData - 当前帧图像数据
     * @returns {Object} 处理结果
     */
    processDetection(detection, frameData = null) {
        if (this.state !== RegistrationState.COLLECTING) {
            return { accepted: false, reason: 'not_collecting' };
        }

        // 检查时间间隔
        const now = Date.now();
        if (now - this._lastCaptureTime < this.config.captureInterval) {
            return { accepted: false, reason: 'too_fast' };
        }

        // 检查人脸质量
        const qualityCheck = this._checkQuality(detection);
        if (!qualityCheck.passed) {
            return { accepted: false, reason: qualityCheck.reason };
        }

        // 获取特征向量
        const descriptor = detection.descriptor;
        if (!descriptor) {
            return { accepted: false, reason: 'no_descriptor' };
        }

        // 检查是否与已采集的太相似（避免重复帧）
        if (this.descriptors.length > 0) {
            const minDistance = this._getMinDistance(descriptor);
            if (minDistance < this.config.similarityThreshold) {
                return { accepted: false, reason: 'too_similar', distance: minDistance };
            }
        }

        // 检查一致性（确保是同一个人）
        if (this.descriptors.length > 0) {
            if (!this._isConsistent(descriptor)) {
                return { accepted: false, reason: 'inconsistent' };
            }
        }

        // 采集成功！
        this.descriptors.push(new Float32Array(descriptor));
        this._lastCaptureTime = now;

        // 生成缩略图
        let thumbnail = null;
        if (frameData) {
            thumbnail = this._generateThumbnail(detection, frameData);
            if (thumbnail) {
                this.capturedFrames.push(thumbnail);
            }
        }

        // 保存进度
        if (this._storage && this.config.autoSaveProgress) {
            this._saveProgress();
        }

        // 触发回调
        const progress = this.getProgress();
        if (this.onCapture) {
            this.onCapture({
                index: this.descriptors.length,
                thumbnail,
                progress
            });
        }
        if (this.onProgress) {
            this.onProgress(progress);
        }

        // 检查是否完成
        if (this.descriptors.length >= this.config.maxCaptures) {
            this._finalize();
        }

        return {
            accepted: true,
            count: this.descriptors.length,
            progress
        };
    }

    /**
     * 撤销最后一次采集
     */
    undoLast() {
        if (this.descriptors.length === 0) return false;

        this.descriptors.pop();
        this.capturedFrames.pop();

        if (this._storage && this.config.autoSaveProgress) {
            this._saveProgress();
        }

        if (this.onProgress) {
            this.onProgress(this.getProgress());
        }

        return true;
    }

    // ========== 计算与保存 ==========

    /**
     * 完成采集，计算平均特征向量
     */
    async _finalize() {
        this._setState(RegistrationState.COMPUTING);

        try {
            // 计算平均特征向量
            this.meanDescriptor = this._computeMeanDescriptor(this.descriptors);

            // 保存到 IndexedDB
            if (this._storage) {
                await this._storage.saveUser({
                    userId: this.userId,
                    name: this.userName,
                    descriptors: this.descriptors,
                    meanDescriptor: this.meanDescriptor,
                    frameCount: this.descriptors.length
                });

                // 清除进度
                await this._storage.clearProgress();
            }

            this._setState(RegistrationState.SAVED);

            // 触发完成回调
            if (this.onComplete) {
                this.onComplete({
                    userId: this.userId,
                    userName: this.userName,
                    descriptorCount: this.descriptors.length,
                    meanDescriptor: this.meanDescriptor
                });
            }

        } catch (error) {
            console.error('Finalization error:', error);
            this._setState(RegistrationState.ERROR);
            if (this.onError) {
                this.onError(error);
            }
        }
    }

    /**
     * 手动触发完成（即使未采集满）
     */
    async finishEarly() {
        if (this.descriptors.length < 3) {
            throw new Error('Need at least 3 captures to finish');
        }
        await this._finalize();
    }

    // ========== 工具方法 ==========

    /**
     * 计算平均特征向量
     */
    _computeMeanDescriptor(descriptors) {
        if (!descriptors || descriptors.length === 0) return null;

        const len = descriptors[0].length;
        const mean = new Float32Array(len);

        descriptors.forEach(desc => {
            for (let i = 0; i < len; i++) {
                mean[i] += desc[i];
            }
        });

        for (let i = 0; i < len; i++) {
            mean[i] /= descriptors.length;
        }

        return mean;
    }

    /**
     * 检查人脸质量
     */
    _checkQuality(detection) {
        if (!detection || !detection.detection) {
            return { passed: false, reason: 'no_detection' };
        }

        const score = detection.detection._score || detection.detection.score || 0;
        if (score < this.config.qualityScoreThreshold) {
            return { passed: false, reason: 'low_confidence', score };
        }

        // 检查人脸大小（可选）
        const box = detection.alignedRect?._box || detection.detection._box;
        if (box) {
            // 这里可以添加人脸大小检查
        }

        return { passed: true };
    }

    /**
     * 获取与已采集特征的最小距离
     */
    _getMinDistance(descriptor) {
        let minDist = Infinity;

        for (const ref of this.descriptors) {
            const dist = this._euclideanDistance(descriptor, ref);
            if (dist < minDist) {
                minDist = dist;
            }
        }

        return minDist;
    }

    /**
     * 检查是否与已采集的一致（同一个人）
     */
    _isConsistent(descriptor) {
        for (const ref of this.descriptors) {
            const dist = this._euclideanDistance(descriptor, ref);
            if (dist > this.config.consistencyThreshold) {
                return false;
            }
        }
        return true;
    }

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
     * 生成缩略图
     */
    _generateThumbnail(detection, frameData) {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // 缩略图大小
            const thumbSize = 64;
            canvas.width = thumbSize;
            canvas.height = thumbSize;

            // 从 ImageData 创建临时 canvas
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = frameData.width;
            tempCanvas.height = frameData.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(frameData, 0, 0);

            // 获取人脸区域
            const box = detection.alignedRect?._box || detection.detection._box;
            if (box) {
                // 裁剪人脸区域并缩放
                ctx.drawImage(
                    tempCanvas,
                    box._x || box.x,
                    box._y || box.y,
                    box._width || box.width,
                    box._height || box.height,
                    0, 0, thumbSize, thumbSize
                );
            } else {
                // 缩放整个图像
                ctx.drawImage(tempCanvas, 0, 0, thumbSize, thumbSize);
            }

            return canvas.toDataURL('image/jpeg', 0.7);
        } catch (error) {
            console.warn('Thumbnail generation failed:', error);
            return null;
        }
    }

    // ========== 状态管理 ==========

    _setState(newState) {
        const oldState = this.state;
        this.state = newState;

        console.log(`Registration state: ${oldState} -> ${newState}`);

        if (this.onStateChange) {
            this.onStateChange({ oldState, newState });
        }
    }

    getProgress() {
        return {
            current: this.descriptors.length,
            total: this.config.maxCaptures,
            percentage: Math.round((this.descriptors.length / this.config.maxCaptures) * 100)
        };
    }

    getState() {
        return this.state;
    }

    // ========== 进度持久化 ==========

    async _saveProgress() {
        if (!this._storage) return;

        try {
            await this._storage.saveProgress({
                userId: this.userId,
                userName: this.userName,
                descriptors: this.descriptors.map(d => Array.from(d)),
                capturedFrames: this.capturedFrames,
                state: this.state
            });
        } catch (error) {
            console.warn('Failed to save progress:', error);
        }
    }

    async _loadProgress() {
        if (!this._storage) return;

        try {
            const progress = await this._storage.loadProgress();

            if (progress && progress.descriptors && progress.descriptors.length > 0) {
                this.userId = progress.userId || '';
                this.userName = progress.userName || '';
                this.descriptors = progress.descriptors.map(d => new Float32Array(d));
                this.capturedFrames = progress.capturedFrames || [];

                if (progress.state === RegistrationState.COLLECTING) {
                    this.state = RegistrationState.COLLECTING;
                }

                console.log(`Loaded ${this.descriptors.length} saved captures`);

                if (this.onProgress) {
                    this.onProgress(this.getProgress());
                }
            }
        } catch (error) {
            console.warn('Failed to load progress:', error);
        }
    }

    // ========== 导出数据 ==========

    /**
     * 获取注册结果（用于导出）
     */
    getRegistrationData() {
        return {
            id: this.userId,
            name: this.userName,
            descriptors: this.descriptors.map(d => Array.from(d)),
            meanDescriptor: this.meanDescriptor ? Array.from(this.meanDescriptor) : null,
            captureCount: this.descriptors.length,
            registeredAt: Date.now()
        };
    }

    /**
     * 下载注册数据为 JSON
     */
    downloadAsJSON() {
        const data = this.getRegistrationData();
        const jsonStr = JSON.stringify([data], null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `face_${this.userId}_${Date.now()}.json`;
        link.click();

        URL.revokeObjectURL(url);
    }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FaceRegistrationManager, RegistrationState };
}
