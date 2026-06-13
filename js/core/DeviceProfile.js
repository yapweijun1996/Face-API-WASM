/**
 * DeviceProfile.js
 * ----------------
 * 设备能力探测 + 检测器模型推荐（纯逻辑，可 Node 单测）。
 *
 * 背景：
 *   - SSD MobileNet v1（~5.4MB）：精度高、慢。适合桌面/高端机。
 *   - TinyFaceDetector（~190KB）：快、小、对远处小脸略弱。适合移动/低端机。
 *
 * 策略：只在用户**没有显式选择**模型时，用本推荐作为默认值。
 *      用户在 settings.html 里存的选择永远优先（HTML 里 `savedSettings... || recommend()`）。
 */

(function (root) {
    'use strict';

    /**
     * 根据设备能力推荐检测器模型。
     * @param {object} [nav] navigator-like 对象（默认全局 navigator）。注入便于单测。
     * @returns {'ssd'|'tiny'}
     */
    function recommendDetectorModel(nav) {
        const n = nav || (typeof navigator !== 'undefined' ? navigator : {});

        const ua = String(n.userAgent || '');
        const isMobile = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(ua);
        if (isMobile) return 'tiny';

        // 逻辑核心数：<=4 视为低端，用快模型。拿不到时按"中端"处理（不阻塞升级）。
        const cores = n.hardwareConcurrency;
        if (typeof cores === 'number' && cores > 0 && cores <= 4) return 'tiny';

        // 设备内存（GB，部分浏览器支持）：<=4GB 用快模型。
        const mem = n.deviceMemory;
        if (typeof mem === 'number' && mem > 0 && mem <= 4) return 'tiny';

        // 高端桌面：用更准的 SSD。
        return 'ssd';
    }

    const api = { recommendDetectorModel };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DeviceProfile = api;

})(typeof self !== 'undefined' ? self : this);
