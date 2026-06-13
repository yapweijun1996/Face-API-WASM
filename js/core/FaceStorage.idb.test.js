/**
 * FaceStorage.idb.test.js
 * ------------------------
 * 集成测试：用 fake-indexeddb 跑真实 IDB 协议。
 * node --test js/core/FaceStorage.idb.test.js
 *
 * 关键回归：tx.abort()（模拟 QuotaExceededError）必须让调用方收到 reject，而非永远挂起。
 */
const test   = require('node:test');
const assert = require('node:assert');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

// 每个测试注入一个独立的 IDBFactory 实例（namespace 隔离），
// FaceStorage.init() 在调用时读取 globalThis.indexedDB，
// 所以切换 global 就能给每个测试一个干净的 DB。
const { FaceStorage } = require('./FaceStorage.js');

function freshDb() {
    globalThis.indexedDB  = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    return new FaceStorage();
}

const vec = (len, fill) => { const a = new Float32Array(len); a.fill(fill); return a; };

// ─── CRUD 正向路径 ───────────────────────────────────────────────────────────

test('idb: saveUser + getUser round-trip', async () => {
    const fs = freshDb();
    await fs.init();

    await fs.saveUser({ userId: 'u1', name: 'Alice', descriptors: [vec(4, 0.1)], meanDescriptor: null, descriptorClusters: null });

    const user = await fs.getUser('u1');
    assert.strictEqual(user.userId, 'u1');
    assert.strictEqual(user.name, 'Alice');
    assert.ok(user.descriptors[0] instanceof Float32Array);
});

test('idb: getAllUsers 返回全部用户', async () => {
    const fs = freshDb();
    await fs.init();

    await fs.saveUser({ userId: 'u1', name: 'Alice', descriptors: [vec(4, 0.1)], meanDescriptor: null, descriptorClusters: null });
    await fs.saveUser({ userId: 'u2', name: 'Bob',   descriptors: [vec(4, 0.9)], meanDescriptor: null, descriptorClusters: null });

    const users = await fs.getAllUsers();
    assert.strictEqual(users.length, 2);
    assert.deepStrictEqual(users.map(u => u.userId).sort(), ['u1', 'u2']);
});

test('idb: deleteUser 删除后 getUser 返回 null', async () => {
    const fs = freshDb();
    await fs.init();

    await fs.saveUser({ userId: 'u1', name: 'Alice', descriptors: [vec(4, 0.1)], meanDescriptor: null, descriptorClusters: null });
    await fs.deleteUser('u1');

    assert.strictEqual(await fs.getUser('u1'), null);
});

test('idb: getUser 不存在时返回 null', async () => {
    const fs = freshDb();
    await fs.init();
    assert.strictEqual(await fs.getUser('nobody'), null);
});

// ─── 进度管理 ─────────────────────────────────────────────────────────────────

test('idb: saveProgress + loadProgress round-trip', async () => {
    const fs = freshDb();
    await fs.init();

    await fs.saveProgress({ userId: 'u1', userName: 'Alice', descriptors: [[0.1, 0.2]] });
    const p = await fs.loadProgress();
    assert.strictEqual(p.userId, 'u1');
    assert.deepStrictEqual(p.descriptors, [[0.1, 0.2]]);
});

test('idb: loadProgress 无数据时返回 null', async () => {
    const fs = freshDb();
    await fs.init();
    assert.strictEqual(await fs.loadProgress(), null);
});

test('idb: clearProgress 后 loadProgress 返回 null', async () => {
    const fs = freshDb();
    await fs.init();
    await fs.saveProgress({ userId: 'u1' });
    await fs.clearProgress();
    assert.strictEqual(await fs.loadProgress(), null);
});

// ─── JSON 导入/导出 ───────────────────────────────────────────────────────────

test('idb: exportToJSON + importFromJSON round-trip', async () => {
    const fs = freshDb();
    await fs.init();

    await fs.saveUser({
        userId: 'u1', name: 'Alice',
        descriptors: [vec(128, 0.5)],
        meanDescriptor: vec(128, 0.5),
        descriptorClusters: [vec(128, 0.4), vec(128, 0.6)]
    });

    const json    = await fs.exportToJSON();
    const parsed  = JSON.parse(json);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'u1');
    assert.strictEqual(parsed[0].name, 'Alice');
    assert.strictEqual(parsed[0].descriptorClusters.length, 2);

    // 导入到新的 DB
    const fs2 = freshDb();
    await fs2.init();
    const result = await fs2.importFromJSON(json);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.skipped, 0);

    const users = await fs2.getAllUsers();
    assert.strictEqual(users.length, 1);
    assert.ok(users[0].meanDescriptor instanceof Float32Array);
    assert.ok(users[0].descriptorClusters[0] instanceof Float32Array);
});

// ─── 关键回归：tx.abort() 路径（QuotaExceededError 模拟） ───────────────────
//
// fake-indexeddb 不会自动触发配额错误，但我们可以用 tx.abort() 强制模拟：
// 它会触发 tx.onabort，这正是我们修复的路径。
// 若没有 _req() 的 tx.onabort 监听，Promise 会永远 pending（测试将超时）。

test('idb: tx.abort() 模拟 QuotaExceededError — saveUser 必须 reject 而非挂起', async () => {
    const fs = freshDb();
    await fs.init();

    // 拦截 transaction()，在请求发出后立即 abort
    const origTx = fs.db.transaction.bind(fs.db);
    fs.db.transaction = (...args) => {
        const tx = origTx(...args);
        // 等 put request 建立后（下一个 microtask）才 abort，
        // 以确保 _req() 已经挂载 tx.onabort 监听器。
        Promise.resolve().then(() => tx.abort());
        return tx;
    };

    await assert.rejects(
        () => fs.saveUser({ userId: 'u99', name: 'Ghost', descriptors: [vec(4, 0)], meanDescriptor: null, descriptorClusters: null }),
        // fake-indexeddb 触发 onabort 时 tx.error 通常为 null，
        // 我们的兜底消息是 'IndexedDB transaction aborted'
        /aborted|AbortError/i
    );
});

test('idb: tx.abort() 模拟 — getAllUsers 也 reject 而非挂起', async () => {
    const fs = freshDb();
    await fs.init();

    const origTx = fs.db.transaction.bind(fs.db);
    fs.db.transaction = (...args) => {
        const tx = origTx(...args);
        Promise.resolve().then(() => tx.abort());
        return tx;
    };

    await assert.rejects(
        () => fs.getAllUsers(),
        /aborted|AbortError/i
    );
});
