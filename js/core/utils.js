/**
 * utils.js
 * --------
 * /js/core/ 内共享的纯工具函数。
 * 以 plain <script> 加载（非 ES module），挂载到 window.FaceUtils。
 *
 * 规则：
 *  - 只放纯函数（无副作用、无 DOM、无 IndexedDB）
 *  - 不引入任何外部依赖
 *  - Node.js 可直接 require（core.test.js 通过 globalThis 注入）
 */

(function (global) {
    /**
     * 欧几里得距离（L2 norm）
     *
     * 维度不匹配时返回 Infinity：
     *   - 避免 undefined 产生 NaN，NaN < threshold 永远 false，
     *     会把本该匹配的用户静默判为 NO_MATCH。
     *   - 返回 Infinity 让该比对自然落选，不污染结果集。
     *
     * @param {ArrayLike<number>|null} a
     * @param {ArrayLike<number>|null} b
     * @returns {number}
     */
    function euclideanDistance(a, b) {
        if (!a || !b || a.length !== b.length) return Infinity;
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            const diff = a[i] - b[i];
            sum += diff * diff;
        }
        return Math.sqrt(sum);
    }

    global.FaceUtils = global.FaceUtils || {};
    global.FaceUtils.euclideanDistance = euclideanDistance;

}(typeof globalThis !== 'undefined' ? globalThis : window));
