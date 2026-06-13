/**
 * tms-geometry.test.js
 * --------------------
 * Pure logic tests for passive landmark geometry spoof signal.
 */
const test = require('node:test');
const assert = require('node:assert');
const G = require('./tms-geometry.js');

function baseFace() {
    const pts = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
    pts[2] = { x: 80, y: 145 };
    pts[8] = { x: 160, y: 245 };
    pts[14] = { x: 240, y: 145 };
    pts[27] = { x: 160, y: 120 };
    pts[30] = { x: 160, y: 165 };
    pts[36] = { x: 125, y: 115 };
    pts[45] = { x: 195, y: 115 };
    pts[48] = { x: 135, y: 205 };
    pts[54] = { x: 185, y: 205 };
    return pts;
}

function movedFace(yaw, depth) {
    const pts = baseFace().map(p => ({ ...p }));
    pts[30].x += yaw * 95;
    pts[27].x += yaw * 35;
    pts[48].x -= yaw * 18;
    pts[54].x -= yaw * 12;
    pts[2].x += yaw * 12;
    pts[14].x -= yaw * 12;
    pts[30].y += depth * 40;
    pts[48].y += depth * 16;
    pts[54].y += depth * 16;
    pts[8].y += depth * 10;
    return pts;
}

function planarFace(yaw) {
    const pts = baseFace().map(p => ({ ...p }));
    pts[30].x += yaw * 95;
    pts[27].x += yaw * 35;
    pts[48].x -= yaw * 18;
    pts[54].x -= yaw * 12;
    return pts;
}

test('assess: insufficient samples is not suspect', () => {
    let buf = [];
    buf = G.addSample(buf, baseFace(), 0);
    const r = G.assess(buf);
    assert.strictEqual(r.suspect, false);
    assert.strictEqual(r.reason, 'insufficient_samples');
    assert.strictEqual(r.metrics.sampleCount, 1);
});

test('assess: normal yaw with non-planar parallax stays low score', () => {
    let buf = [];
    [-0.08, -0.03, 0.02, 0.07].forEach((yaw, i) => {
        buf = G.addSample(buf, movedFace(yaw, Math.abs(yaw) * 0.9), i * 400);
    });
    const r = G.assess(buf);
    assert.strictEqual(r.suspect, false);
    assert.ok(r.score < 0.72, `expected low score, got ${r.score}`);
    assert.strictEqual(r.reason, 'non_planar_motion_observed');
});

test('assess: planar transform with yaw-like motion is suspect', () => {
    let buf = [];
    [-0.08, -0.03, 0.03, 0.08].forEach((yaw, i) => {
        buf = G.addSample(buf, planarFace(yaw), i * 400);
    });
    const r = G.assess(buf);
    assert.strictEqual(r.suspect, true);
    assert.ok(r.score >= 0.72, `expected high score, got ${r.score}`);
    assert.strictEqual(r.reason, 'planar_landmark_motion');
});

test('assess: invalid landmarks do not throw', () => {
    let buf = [];
    assert.doesNotThrow(() => {
        buf = G.addSample(buf, null, 0);
        buf = G.addSample(buf, [{ x: 1, y: 2 }], 1);
    });
    const r = G.assess(buf);
    assert.strictEqual(r.suspect, false);
    assert.strictEqual(r.metrics.sampleCount, 0);
});
