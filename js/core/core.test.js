/**
 * core.test.js
 * ------------
 * 纯逻辑单测：node --test js/core/core.test.js
 * 覆盖 P2-2（多簇 k-means + 匹配器消费簇）、P2-3（设备推荐模型）、P1-2（去抖调度）。
 */
const test = require('node:test');
const assert = require('node:assert');

// utils.js 把 FaceUtils 挂到 globalThis（浏览器里以 <script> 加载）；
// 测试里 require 一次即注入全局，供 FaceMatcher/FaceRegistrationManager 使用。
require('./utils.js');

const { computeKMeans } = require('./FaceRegistrationManager.js');
const { FaceMatcher, MatchResult } = require('./FaceMatcher.js');
const { recommendDetectorModel } = require('./DeviceProfile.js');
const { fpsFromTimestamps, pruneTimestamps, formatStats, isDebugEnabled, buildExtraLines } = require('./PerfOverlay.js');

// ---------- helpers ----------
function vec(dim, fill) { const a = new Float32Array(dim); a.fill(fill); return a; }

// ============ P2-2: computeKMeans ============
test('computeKMeans: k>=n 时每帧各自成簇', () => {
    const ds = [vec(4, 1), vec(4, 2)];
    const c = computeKMeans(ds, 3);
    assert.strictEqual(c.length, 2);
});

test('computeKMeans: k=1 退化为均值', () => {
    const ds = [vec(3, 0), vec(3, 2)];
    const c = computeKMeans(ds, 1);
    assert.strictEqual(c.length, 1);
    assert.ok(Math.abs(c[0][0] - 1) < 1e-6); // (0+2)/2 = 1
});

test('computeKMeans: 两个明显分离的簇被分开', () => {
    // 5 个靠近 0，5 个靠近 10
    const ds = [];
    for (let i = 0; i < 5; i++) ds.push(vec(8, 0 + i * 0.01));
    for (let i = 0; i < 5; i++) ds.push(vec(8, 10 + i * 0.01));
    const c = computeKMeans(ds, 2);
    assert.strictEqual(c.length, 2);
    const means = c.map(x => x[0]).sort((a, b) => a - b);
    assert.ok(means[0] < 1, `low cluster ~0, got ${means[0]}`);
    assert.ok(means[1] > 9, `high cluster ~10, got ${means[1]}`);
});

test('computeKMeans: 空输入返回空', () => {
    assert.deepStrictEqual(computeKMeans([], 3), []);
    assert.deepStrictEqual(computeKMeans(null, 3), []);
});

test('computeKMeans: 确定性（同输入同输出）', () => {
    const mk = () => [vec(4, 1), vec(4, 5), vec(4, 9), vec(4, 2), vec(4, 8)];
    const a = computeKMeans(mk(), 2).map(v => Array.from(v));
    const b = computeKMeans(mk(), 2).map(v => Array.from(v));
    assert.deepStrictEqual(a, b);
});

// ============ P2-2: FaceMatcher 消费簇 ============
test('FaceMatcher: 有 clusters 时索引簇而非 mean', () => {
    const m = new FaceMatcher();
    m._processUsers([{
        id: 'u1', name: 'A',
        descriptors: [vec(4, 1)],
        meanDescriptor: vec(4, 5),
        descriptorClusters: [vec(4, 1), vec(4, 2), vec(4, 3)]
    }]);
    // 3 个簇 → 3 条索引；descriptorToUser 都指向 user 0
    assert.strictEqual(m.descriptors.length, 3);
    assert.deepStrictEqual(m.descriptorToUser, [0, 0, 0]);
});

test('FaceMatcher: 无 clusters 回退到 meanDescriptor', () => {
    const m = new FaceMatcher();
    m._processUsers([{
        id: 'u1', name: 'A',
        descriptors: [vec(4, 1), vec(4, 2)],
        meanDescriptor: vec(4, 5)
    }]);
    assert.strictEqual(m.descriptors.length, 1); // 仅 mean
    assert.strictEqual(m.descriptors[0][0], 5);
});

test('FaceMatcher: descriptorToUser 索引正确（双用户）', () => {
    const m = new FaceMatcher();
    m._processUsers([
        { id: 'u1', name: 'A', descriptors: [vec(4, 1)], descriptorClusters: [vec(4, 1), vec(4, 2)] },
        { id: 'u2', name: 'B', descriptors: [vec(4, 9)], descriptorClusters: [vec(4, 9)] }
    ]);
    // u1: 2 簇 → idx0,0 ; u2: 1 簇 → idx1
    assert.deepStrictEqual(m.descriptorToUser, [0, 0, 1]);
    assert.strictEqual(m.registeredUsers[0].id, 'u1');
    assert.strictEqual(m.registeredUsers[1].id, 'u2');
});

test('FaceMatcher: 簇匹配命中最近质心', () => {
    const m = new FaceMatcher({ matchThreshold: 0.6 });
    m._processUsers([{
        id: 'u1', name: 'A',
        descriptors: [vec(128, 0.1)],
        descriptorClusters: [vec(128, 0.1), vec(128, 0.5)]
    }]);
    // 查询接近第二个簇(0.5)
    const res = m.findBestMatch(vec(128, 0.5));
    assert.strictEqual(res.status, MatchResult.MATCHED);
    assert.strictEqual(res.user.id, 'u1');
    assert.ok(res.distance < 0.01, `distance should be ~0, got ${res.distance}`);
});

// ============ P2-3: recommendDetectorModel ============
test('recommendDetectorModel: 移动端 → tiny', () => {
    assert.strictEqual(recommendDetectorModel({ userAgent: 'iPhone', hardwareConcurrency: 6 }), 'tiny');
    assert.strictEqual(recommendDetectorModel({ userAgent: 'Android', hardwareConcurrency: 8 }), 'tiny');
});

test('recommendDetectorModel: 低核桌面 → tiny', () => {
    assert.strictEqual(recommendDetectorModel({ userAgent: 'Macintosh', hardwareConcurrency: 4 }), 'tiny');
});

test('recommendDetectorModel: 高端桌面 → ssd', () => {
    assert.strictEqual(recommendDetectorModel({ userAgent: 'Macintosh', hardwareConcurrency: 12, deviceMemory: 16 }), 'ssd');
});

test('recommendDetectorModel: 低内存桌面 → tiny', () => {
    assert.strictEqual(recommendDetectorModel({ userAgent: 'Windows NT', hardwareConcurrency: 8, deviceMemory: 4 }), 'tiny');
});

test('recommendDetectorModel: 信息缺失 → 默认 ssd（不阻塞升级）', () => {
    assert.strictEqual(recommendDetectorModel({}), 'ssd');
});

// ============ P1-2: 去抖调度（用真实 timer + 假 storage） ============
test('debounce: 多次调度只写一次盘', async () => {
    const { FaceRegistrationManager } = require('./FaceRegistrationManager.js');
    let writes = 0;
    const fakeStorage = {
        saveProgress: async () => { writes++; },
        clearProgress: async () => {},
        loadProgress: async () => null
    };
    const mgr = new FaceRegistrationManager({ saveProgressDebounceMs: 50 });
    mgr._storage = fakeStorage;
    mgr.userId = 'u'; mgr.userName = 'n';
    mgr.descriptors = [vec(4, 1)];

    mgr._scheduleSaveProgress();
    mgr._scheduleSaveProgress();
    mgr._scheduleSaveProgress();
    assert.strictEqual(writes, 0, '去抖期间不应写盘');
    await new Promise(r => setTimeout(r, 90));
    assert.strictEqual(writes, 1, '去抖结束后只写一次');
});

// ============ P1-3: PerfOverlay 纯逻辑 ============
test('fpsFromTimestamps: 统计窗口内帧数', () => {
    // now=1000, window=1000 → 统计 [0,1000] 内
    const ts = [100, 300, 600, 900, 1000];
    assert.strictEqual(fpsFromTimestamps(ts, 1000, 1000), 5);
});

test('fpsFromTimestamps: 窗口外的旧帧不计', () => {
    const ts = [100, 300, 1600, 1800, 2000];
    // now=2000, window=1000 → cutoff=1000 → 只数 >=1000 的 (1600,1800,2000)
    assert.strictEqual(fpsFromTimestamps(ts, 2000, 1000), 3);
});

test('pruneTimestamps: 丢弃窗口外旧帧', () => {
    const ts = [100, 300, 1600, 1800, 2000];
    pruneTimestamps(ts, 2000, 1000);
    assert.deepStrictEqual(ts, [1600, 1800, 2000]);
});

test('formatStats: 多行格式化', () => {
    const s = formatStats({ fps: 12, inferenceMs: 33.33, matchMs: 0.456, backend: 'wasm', model: 'ssd', users: 3, clusters: 9 });
    assert.match(s, /FPS: 12/);
    assert.match(s, /Inference: 33\.3 ms/);
    assert.match(s, /Match: 0\.46 ms/);
    assert.match(s, /Backend: wasm/);
    assert.match(s, /Users: 3 \(9 clusters\)/);
});

test('formatStats: 缺失字段不输出对应行', () => {
    const s = formatStats({ fps: 5 });
    assert.strictEqual(s, 'FPS: 5');
});

test('formatStats: extra 数组追加分割线和各行', () => {
    const s = formatStats({ fps: 10, extra: ['Backend: 42ms', 'Model loading: 300ms'] });
    assert.match(s, /FPS: 10/);
    assert.match(s, /──────────/);
    assert.match(s, /Backend: 42ms/);
    assert.match(s, /Model loading: 300ms/);
});

test('formatStats: extra 为空数组时不追加分割线', () => {
    const s = formatStats({ fps: 10, extra: [] });
    assert.strictEqual(s, 'FPS: 10');
});

// ============ FaceUtils.formatDuration ============
test('formatDuration: <1s 显示毫秒', () => {
    assert.strictEqual(FaceUtils.formatDuration(450), '450ms');
});

test('formatDuration: 1s-59s 显示秒', () => {
    assert.strictEqual(FaceUtils.formatDuration(5000), '5s');
    assert.strictEqual(FaceUtils.formatDuration(59400), '59s'); // rounds to 59s
});

test('formatDuration: >=60s 显示 Xm Ys', () => {
    assert.strictEqual(FaceUtils.formatDuration(65000), '1m 5s');
    assert.strictEqual(FaceUtils.formatDuration(120000), '2m 0s');
    assert.strictEqual(FaceUtils.formatDuration(3661000), '61m 1s');
});

test('isDebugEnabled: ?debug=1 开启', () => {
    assert.strictEqual(isDebugEnabled({ search: '?debug=1' }, null), true);
    assert.strictEqual(isDebugEnabled({ search: '?foo=1&debug=1' }, null), true);
});

test('isDebugEnabled: 无 debug 关闭', () => {
    assert.strictEqual(isDebugEnabled({ search: '' }, null), false);
    assert.strictEqual(isDebugEnabled({ search: '?debug=0' }, null), false);
});

test('isDebugEnabled: localStorage faceDebug=1 开启', () => {
    const fakeStore = { getItem: (k) => k === 'faceDebug' ? '1' : null };
    assert.strictEqual(isDebugEnabled({ search: '' }, fakeStore), true);
});

test('debounce: _cancelScheduledSave 阻止写盘（清理竞态防护）', async () => {
    const { FaceRegistrationManager } = require('./FaceRegistrationManager.js');
    let writes = 0;
    const fakeStorage = {
        saveProgress: async () => { writes++; },
        clearProgress: async () => {},
        loadProgress: async () => null
    };
    const mgr = new FaceRegistrationManager({ saveProgressDebounceMs: 50 });
    mgr._storage = fakeStorage;
    mgr.descriptors = [vec(4, 1)];

    mgr._scheduleSaveProgress();
    mgr._cancelScheduledSave();   // 模拟 cancel()/finalize() 取消
    await new Promise(r => setTimeout(r, 90));
    assert.strictEqual(writes, 0, '取消后不应写盘');
});

// ============ buildExtraLines ============
test('buildExtraLines: 过滤 face- 前缀、排除 Total、去掉命名空间', () => {
    const fake = {
        getEntriesByType: () => [
            { name: 'face-init: Backend setup', duration: 123.7 },
            { name: 'face-init: Model loading', duration: 800 },
            { name: 'face-init: JSON load', duration: 88.3 },
            { name: 'face-init: Total', duration: 999 },
            { name: 'face-reg: Full registration flow', duration: 456.2 },
            { name: 'other: Unrelated', duration: 10 },
        ]
    };
    const lines = buildExtraLines(fake);
    assert.deepStrictEqual(lines, [
        'Backend setup: 124ms',
        'Model loading: 800ms',
        'JSON load: 88ms',
        'Full registration flow: 456ms'
    ]);
});

test('buildExtraLines: count < 0 时追加 (err) 后缀', () => {
    const fake = {
        getEntriesByType: () => [
            { name: 'face-init: JSON load', duration: 88, detail: { count: -1 } },
            { name: 'face-init: Storage init', duration: 210, detail: { count: 0 } },
        ]
    };
    const lines = buildExtraLines(fake);
    assert.deepStrictEqual(lines, [
        'JSON load: 88ms (err)',
        'Storage init: 210ms'
    ]);
});

test('buildExtraLines: perfApi 无效时返回空数组', () => {
    assert.deepStrictEqual(buildExtraLines(null), []);
    assert.deepStrictEqual(buildExtraLines({ getEntriesByType: null }), []);
    assert.deepStrictEqual(buildExtraLines({}), []);
});
