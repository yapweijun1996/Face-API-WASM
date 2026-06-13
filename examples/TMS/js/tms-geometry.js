/**
 * tms-geometry.js
 * ---------------
 * Passive face-geometry spoof signal for TMS.
 *
 * This is not certified PAD. It is a lightweight, dependency-free heuristic
 * that watches 68-point face landmarks across passive frames and asks:
 * does landmark motion look more like a non-planar live face, or a flat image?
 */
(function (root) {
    'use strict';

    const DEFAULTS = {
        maxAgeMs: 2500,
        maxSamples: 12,
        minSamples: 4,
        minYawDelta: 0.045,
        suspectScore: 0.72
    };

    const IDX = {
        leftEyeOuter: 36,
        rightEyeOuter: 45,
        noseBridge: 27,
        noseTip: 30,
        mouthLeft: 48,
        mouthRight: 54,
        chin: 8,
        cheekLeft: 2,
        cheekRight: 14
    };

    function clamp01(n) {
        n = Number(n);
        if (!isFinite(n)) return 0;
        return Math.max(0, Math.min(1, n));
    }

    function toPoints(landmarks) {
        const src = landmarks && landmarks.positions ? landmarks.positions : landmarks;
        if (!Array.isArray(src) || src.length < 68) return null;
        const pts = src.map(p => ({
            x: Number(p && p.x),
            y: Number(p && p.y)
        }));
        return pts.every(p => isFinite(p.x) && isFinite(p.y)) ? pts : null;
    }

    function dist(a, b) {
        const dx = a.x - b.x, dy = a.y - b.y;
        return Math.hypot(dx, dy);
    }

    function featureFromLandmarks(landmarks) {
        const pts = toPoints(landmarks);
        if (!pts) return null;

        const le = pts[IDX.leftEyeOuter];
        const re = pts[IDX.rightEyeOuter];
        const nose = pts[IDX.noseTip];
        const noseBridge = pts[IDX.noseBridge];
        const ml = pts[IDX.mouthLeft];
        const mr = pts[IDX.mouthRight];
        const chin = pts[IDX.chin];
        const cl = pts[IDX.cheekLeft];
        const cr = pts[IDX.cheekRight];
        const faceW = Math.max(1, dist(cl, cr), dist(le, re) * 2.2);
        const eyeCenter = { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
        const mouthCenter = { x: (ml.x + mr.x) / 2, y: (ml.y + mr.y) / 2 };

        return {
            yaw: (nose.x - eyeCenter.x) / faceW,
            noseDepth: dist(nose, noseBridge) / faceW,
            mouthDepth: (mouthCenter.y - eyeCenter.y) / faceW,
            chinDepth: (chin.y - eyeCenter.y) / faceW,
            mouthWidth: dist(ml, mr) / faceW,
            cheekBalance: (dist(nose, cl) - dist(nose, cr)) / faceW
        };
    }

    function addSample(buffer, landmarks, nowTs, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const list = Array.isArray(buffer) ? buffer : [];
        const feature = featureFromLandmarks(landmarks);
        if (!feature) return list;

        const ts = Number(nowTs);
        list.push({ t: isFinite(ts) ? ts : Date.now(), feature });
        const cutoff = (isFinite(ts) ? ts : Date.now()) - opts.maxAgeMs;
        while (list.length && list[0].t < cutoff) list.shift();
        while (list.length > opts.maxSamples) list.shift();
        return list;
    }

    function range(values) {
        if (!values.length) return 0;
        return Math.max(...values) - Math.min(...values);
    }

    function assess(buffer, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        const samples = (Array.isArray(buffer) ? buffer : [])
            .map(s => s && s.feature)
            .filter(Boolean);

        if (samples.length < opts.minSamples) {
            return result(false, 0, 'insufficient_samples', {
                yawDelta: 0,
                noseParallax: 0,
                mouthParallax: 0,
                sampleCount: samples.length
            }, opts);
        }

        const yawDelta = range(samples.map(s => s.yaw));
        const noseParallax = range(samples.map(s => s.noseDepth));
        const mouthParallax = range(samples.map(s => s.mouthDepth));
        const chinParallax = range(samples.map(s => s.chinDepth));
        const mouthWidthDelta = range(samples.map(s => s.mouthWidth));

        if (yawDelta < opts.minYawDelta) {
            return result(false, clamp01(yawDelta / opts.minYawDelta * 0.25), 'insufficient_pose_change', {
                yawDelta,
                noseParallax,
                mouthParallax,
                sampleCount: samples.length
            }, opts);
        }

        const parallax = Math.max(noseParallax, mouthParallax, chinParallax, mouthWidthDelta * 0.75);
        const planarMotion = Math.max(0, yawDelta - parallax * 3.5);
        const score = clamp01((planarMotion / Math.max(0.001, opts.minYawDelta)) * 0.68 + (yawDelta > 0.08 && parallax < 0.012 ? 0.18 : 0));
        const suspect = score >= opts.suspectScore;
        return result(suspect, score, suspect ? 'planar_landmark_motion' : 'non_planar_motion_observed', {
            yawDelta,
            noseParallax,
            mouthParallax,
            sampleCount: samples.length
        }, opts);
    }

    function result(suspect, score, reason, metrics, opts) {
        return {
            suspect: !!suspect,
            score: clamp01(score),
            reason,
            metrics: {
                yawDelta: Number((metrics.yawDelta || 0).toFixed(4)),
                noseParallax: Number((metrics.noseParallax || 0).toFixed(4)),
                mouthParallax: Number((metrics.mouthParallax || 0).toFixed(4)),
                sampleCount: metrics.sampleCount || 0
            },
            threshold: opts.suspectScore
        };
    }

    const api = { DEFAULTS, featureFromLandmarks, addSample, assess };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TmsGeometry = api;
})(typeof self !== 'undefined' ? self : this);
