/**
 * PerfOverlay.js
 * --------------
 * 开发性能浮层（?debug=1 才显示）。展示 FPS、推理耗时、匹配耗时、backend。
 *
 * 设计：可测的纯逻辑（FPS 滚动窗口、文本格式化）与浏览器 DOM 分离。
 *       生产默认隐藏——只有 URL 带 ?debug=1（或 localStorage faceDebug=1）才激活，
 *       不激活时所有 record* 调用是零成本 no-op。
 */

(function (root) {
    'use strict';

    // ============ 纯逻辑（浏览器 + Node 共用，单测覆盖） ============

    /**
     * 滚动窗口 FPS：统计 [now-windowMs, now] 内的帧时间戳数量。
     * @param {number[]} timestamps 升序帧时间戳（ms）
     * @param {number} now 当前时间（ms）
     * @param {number} [windowMs=1000]
     * @returns {number} 窗口内帧数 = 近似 FPS（窗口=1s 时即 FPS）
     */
    function fpsFromTimestamps(timestamps, now, windowMs) {
        const w = windowMs || 1000;
        const cutoff = now - w;
        let count = 0;
        for (let i = timestamps.length - 1; i >= 0; i--) {
            if (timestamps[i] >= cutoff) count++;
            else break; // 升序，更早的不用看
        }
        return count;
    }

    /** 丢弃窗口外的旧时间戳（原地裁剪，避免数组无限增长）。 */
    function pruneTimestamps(timestamps, now, windowMs) {
        const w = windowMs || 1000;
        const cutoff = now - w;
        let drop = 0;
        while (drop < timestamps.length && timestamps[drop] < cutoff) drop++;
        if (drop > 0) timestamps.splice(0, drop);
        return timestamps;
    }

    /**
     * 把统计量格式化为多行文本（浮层与 canvas 共用）。
     * @param {{fps?:number, inferenceMs?:number, matchMs?:number, backend?:string, model?:string, users?:number, clusters?:number}} s
     * @returns {string}
     */
    function formatStats(s) {
        const o = s || {};
        const lines = [];
        if (o.fps != null) lines.push('FPS: ' + o.fps);
        if (o.inferenceMs != null) lines.push('Inference: ' + Number(o.inferenceMs).toFixed(1) + ' ms');
        if (o.matchMs != null) lines.push('Match: ' + Number(o.matchMs).toFixed(2) + ' ms');
        if (o.backend) lines.push('Backend: ' + o.backend);
        if (o.model) lines.push('Model: ' + o.model);
        if (o.users != null) lines.push('Users: ' + o.users + (o.clusters != null ? ' (' + o.clusters + ' clusters)' : ''));
        return lines.join('\n');
    }

    /** 是否启用 debug 浮层（URL ?debug=1 或 localStorage faceDebug=1）。 */
    function isDebugEnabled(loc, storage) {
        try {
            const search = (loc || (typeof location !== 'undefined' ? location : {})).search || '';
            if (/[?&]debug=1\b/.test(search)) return true;
            const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (st && st.getItem && st.getItem('faceDebug') === '1') return true;
        } catch (e) { /* SSR/Node：无 location/localStorage */ }
        return false;
    }

    // ============ 浏览器运行时：浮层单例 ============

    const PerfOverlay = {
        _enabled: false,
        _el: null,
        _frames: [],            // 帧时间戳滚动窗口
        _windowMs: 1000,
        _lastInferenceMs: null,
        _lastMatchMs: null,
        _info: {},
        _lastRender: 0,

        /** 初始化：仅 ?debug=1 时建浮层 DOM。重复调用安全。 */
        init() {
            if (this._enabled) return this;
            if (!isDebugEnabled()) return this;
            this._enabled = true;
            if (typeof document === 'undefined') return this;
            const el = document.createElement('div');
            el.id = 'perf-overlay';
            el.style.cssText = [
                'position:fixed', 'top:8px', 'left:8px', 'z-index:99999',
                'background:rgba(0,0,0,0.78)', 'color:#00d084', 'font:11px/1.45 monospace',
                'padding:8px 10px', 'border-radius:8px', 'white-space:pre',
                'pointer-events:none', 'border:1px solid rgba(0,208,132,0.4)'
            ].join(';');
            el.textContent = 'perf: warming up…';
            (document.body || document.documentElement).appendChild(el);
            this._el = el;
            return this;
        },

        /** 记录一帧推理耗时（ms）。未启用时 no-op。 */
        recordInference(ms, now) {
            if (!this._enabled) return;
            const t = now != null ? now : (typeof performance !== 'undefined' ? performance.now() : 0);
            this._frames.push(t);
            pruneTimestamps(this._frames, t, this._windowMs);
            if (ms != null) this._lastInferenceMs = ms;
            this._render(t);
        },

        /** 记录一次匹配耗时（ms）。未启用时 no-op。 */
        recordMatch(ms) {
            if (!this._enabled) return;
            if (ms != null) this._lastMatchMs = ms;
        },

        /** 设置静态信息（backend / model / users / clusters）。 */
        setInfo(info) {
            if (!this._enabled) return;
            this._info = Object.assign({}, this._info, info || {});
        },

        _render(now) {
            if (!this._el) return;
            // 限频渲染（~4 次/秒），避免每帧改 DOM
            if (now - this._lastRender < 250) return;
            this._lastRender = now;
            const fps = fpsFromTimestamps(this._frames, now, this._windowMs);
            this._el.textContent = formatStats(Object.assign({
                fps,
                inferenceMs: this._lastInferenceMs,
                matchMs: this._lastMatchMs
            }, this._info));
        },

        isEnabled() { return this._enabled; }
    };

    const api = { PerfOverlay, fpsFromTimestamps, pruneTimestamps, formatStats, isDebugEnabled };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else {
        root.PerfOverlay = PerfOverlay;
        root.PerfOverlayUtil = api; // 纯函数也挂出来，便于复用
    }

})(typeof self !== 'undefined' ? self : this);
