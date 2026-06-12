/**
 * tms-tracker.js
 * --------------
 * 极简的人脸位置追踪（multi-object tracking）。
 *
 * 解决的问题：
 *   打卡状态机原先按「员工 id」存 hold/活体/倒计时。一旦同一员工被两张脸同时
 *   匹配到——本人 + 墙上照片、屏幕反射、甚至双胞胎——两张脸就会共享同一个 hold，
 *   互相覆盖倒计时、彼此抢活体进度。
 *
 * 根因修复：
 *   把状态从「按员工」改为「按物理人脸位置」。每帧用 IoU（交并比）把检测框关联到
 *   上一帧的稳定 track；每个 track 有自己跨帧持久的 .data（挂 hold/活体/倒计时）。
 *   两张脸 = 两个 track = 两套独立状态，互不干扰。员工层面的去重（同一人不被打两次）
 *   仍由调用方用 cooldown(empId) 把关。
 *
 * 关联算法：贪心最大 IoU。所有 (框, track) 配对按 IoU 降序，依次认领未被占用的两端；
 * IoU 低于阈值不认领 → 该框开新 track。超过 maxAgeMs 没再出现的 track 被淘汰。
 */
class FaceTracker {
    constructor({ maxAgeMs = 1200, iouThreshold = 0.2 } = {}) {
        this.tracks = [];          // [{ id, box, lastSeen, data }]
        this._nextId = 1;
        this.maxAgeMs = maxAgeMs;  // 容忍偶发漏检：超过这么久没出现才删 track
        this.iouThreshold = iouThreshold;
    }

    _iou(a, b) {
        const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.width, b.x + b.width);
        const y2 = Math.min(a.y + a.height, b.y + b.height);
        const iw = x2 - x1, ih = y2 - y1;
        if (iw <= 0 || ih <= 0) return 0;
        const inter = iw * ih;
        const union = a.width * a.height + b.width * b.height - inter;
        return union > 0 ? inter / union : 0;
    }

    /**
     * 用本帧所有人脸框更新追踪。
     * @returns {Array} 与 boxes 一一对应的 track 数组（result[i] ↔ boxes[i]）。
     *   每个 track 的 .data 跨帧持久，调用方可在上面挂任意状态。
     */
    update(boxes, nowTs) {
        const tracks = this.tracks;
        const result = new Array(boxes.length).fill(null);
        const usedBox = new Set();
        const usedTrack = new Set();

        // 全部 (框 i, track t) 配对，按 IoU 降序贪心认领
        const pairs = [];
        for (let i = 0; i < boxes.length; i++) {
            for (let t = 0; t < tracks.length; t++) {
                pairs.push({ i, t, iou: this._iou(boxes[i], tracks[t].box) });
            }
        }
        pairs.sort((p, q) => q.iou - p.iou);

        for (const p of pairs) {
            if (p.iou < this.iouThreshold) break;        // 余下的更低，无需再看
            if (usedBox.has(p.i) || usedTrack.has(p.t)) continue;
            usedBox.add(p.i); usedTrack.add(p.t);
            const tr = tracks[p.t];
            tr.box = boxes[p.i];
            tr.lastSeen = nowTs;
            result[p.i] = tr;
        }

        // 没认领到 track 的框 → 开新 track（新出现的人脸）
        for (let i = 0; i < boxes.length; i++) {
            if (result[i]) continue;
            const tr = { id: this._nextId++, box: boxes[i], lastSeen: nowTs, data: {} };
            tracks.push(tr);
            result[i] = tr;
        }

        // 淘汰太久没出现的 track（人已离开）
        this.tracks = tracks.filter(tr => nowTs - tr.lastSeen <= this.maxAgeMs);
        return result;
    }

    clear() { this.tracks = []; this._nextId = 1; }
}

// 浏览器全局 + Node（测试）双导出
if (typeof module !== 'undefined' && module.exports) module.exports = { FaceTracker };
