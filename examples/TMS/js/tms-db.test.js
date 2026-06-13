/**
 * tms-db.test.js
 * --------------
 * TmsDB.init() 防挂起测试：onblocked + upgradeTx abort。
 * node --test examples/TMS/js/tms-db.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

// tmsDB 单例在 require 时创建，但构造器只做 this.db = null，不访问 indexedDB。
// 先提供一个 stub 避免模块顶层意外调用（实际不会，但防御）。
globalThis.indexedDB = {
    open: () => ({ onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null })
};
const { TmsDB } = require('./tms-db.js');

test('TmsDB init: onblocked 触发时 reject', async () => {
    let capturedReq;
    globalThis.indexedDB = {
        open: () => {
            capturedReq = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
            setTimeout(() => capturedReq.onblocked && capturedReq.onblocked(), 0);
            return capturedReq;
        }
    };
    const db = new TmsDB();
    await assert.rejects(() => db.init(), /blocked/);
});

test('TmsDB init: onupgradeneeded 事务 abort 触发时 reject', async () => {
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
                setTimeout(() => capturedAbort && capturedAbort(), 0);
            }, 0);
            return req;
        }
    };
    const db = new TmsDB();
    await assert.rejects(() => db.init(), /upgrade aborted/);
});
