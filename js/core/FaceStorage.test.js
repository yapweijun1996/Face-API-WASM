/**
 * FaceStorage.test.js
 * --------------------
 * 针对 _req() 防御层的单测：node --test js/core/FaceStorage.test.js
 *
 * 核心场景：IndexedDB 事务中止（QuotaExceededError 等）时，
 * request.onerror 不会触发，只有 tx.onabort 触发——_req() 必须将其转为 reject。
 */
const test   = require('node:test');
const assert = require('node:assert');

// FaceStorage 在模块顶层执行 `const faceStorage = new FaceStorage()`，
// 构造器只做 `this.db = null`，不访问 indexedDB——所以 require 是安全的。
// 但 require 时全局必须有 indexedDB（模块顶层不访问，但 Node 没有该全局）。
// 用一个最小 stub 满足 require 阶段即可。
globalThis.indexedDB = {
    open: () => { throw new Error('not implemented in test context'); }
};

const { FaceStorage } = require('./FaceStorage.js');

// ─── helpers ────────────────────────────────────────────────────────────────

/** 构造一个只有 onsuccess/onerror 回调槽的假 IDB request（无 transaction）。 */
function fakeReq(result = undefined) {
    return { result, error: null, transaction: null, onsuccess: null, onerror: null };
}

/** 构造一个带 transaction 的假 IDB request。 */
function fakeReqWithTx(txError = null) {
    const tx = { error: txError, onabort: null, onerror: null };
    const req = { result: undefined, error: null, transaction: tx, onsuccess: null, onerror: null };
    return { req, tx };
}

// ─── _req: happy path ───────────────────────────────────────────────────────

test('_req: request.onsuccess 解析为 result', async () => {
    const fs  = new FaceStorage();
    const req = fakeReq(42);
    const p   = fs._req(req);
    req.onsuccess();
    assert.strictEqual(await p, 42);
});

test('_req: result 为 undefined 时正常解析（delete 操作返回 undefined）', async () => {
    const fs  = new FaceStorage();
    const req = fakeReq(undefined);
    const p   = fs._req(req);
    req.onsuccess();
    assert.strictEqual(await p, undefined);
});

// ─── _req: request-level error ──────────────────────────────────────────────

test('_req: request.onerror 触发时 reject', async () => {
    const fs  = new FaceStorage();
    const req = fakeReq();
    req.error  = new Error('ConstraintError');
    const p   = fs._req(req);
    req.onerror();
    await assert.rejects(() => p, /ConstraintError/);
});

// ─── _req: transaction-level abort (the key regression guard) ───────────────

test('_req: tx.onabort 在 request.onerror 未触发时仍能 reject（QuotaExceededError 场景）', async () => {
    const fs          = new FaceStorage();
    const { req, tx } = fakeReqWithTx(new Error('QuotaExceededError'));
    const p           = fs._req(req);
    // request.onerror 刻意不调用，只触发 tx.onabort
    tx.onabort();
    await assert.rejects(() => p, /QuotaExceededError/);
});

test('_req: tx.onerror 触发时 reject', async () => {
    const fs          = new FaceStorage();
    const { req, tx } = fakeReqWithTx(new Error('TransactionInactiveError'));
    const p           = fs._req(req);
    tx.onerror();
    await assert.rejects(() => p, /TransactionInactiveError/);
});

test('_req: tx.error 为 null 时 abort 使用兜底 Error 信息', async () => {
    const fs          = new FaceStorage();
    const { req, tx } = fakeReqWithTx(null); // tx.error = null
    const p           = fs._req(req);
    tx.onabort();
    await assert.rejects(() => p, /IndexedDB transaction aborted/);
});

// ─── _req: no transaction (e.g. readonly getAll) ────────────────────────────

test('_req: transaction 为 null 时不崩溃，onsuccess 正常解析', async () => {
    const fs  = new FaceStorage();
    const req = fakeReq('hello');
    // transaction 已经是 null，_req 内 if (tx) 分支应跳过
    const p   = fs._req(req);
    req.onsuccess();
    assert.strictEqual(await p, 'hello');
});

// ─── init: onblocked + upgrade tx abort ─────────────────────────────────────

test('init: onblocked 触发时 reject', async () => {
    let capturedReq;
    globalThis.indexedDB = {
        open: () => {
            capturedReq = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
            setTimeout(() => capturedReq.onblocked && capturedReq.onblocked(), 0);
            return capturedReq;
        }
    };
    const fs = new FaceStorage();
    await assert.rejects(() => fs.init(), /blocked/);
});

test('init: onupgradeneeded 事务 abort 触发时 reject', async () => {
    let capturedAbort;
    const fakeUpgradeTx = {
        get onabort() { return capturedAbort; },
        set onabort(fn) { capturedAbort = fn; },
        onerror: null,
        error: new Error('upgrade aborted')
    };
    globalThis.indexedDB = {
        open: () => {
            const req = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
            setTimeout(() => {
                if (req.onupgradeneeded) {
                    req.onupgradeneeded({
                        target: {
                            result: { objectStoreNames: { contains: () => true } },
                            transaction: fakeUpgradeTx
                        }
                    });
                }
                // 升级后事务 abort（例如 QuotaExceededError 在建索引时触发）
                setTimeout(() => capturedAbort && capturedAbort(), 0);
            }, 0);
            return req;
        }
    };
    const fs = new FaceStorage();
    await assert.rejects(() => fs.init(), /upgrade aborted/);
});
