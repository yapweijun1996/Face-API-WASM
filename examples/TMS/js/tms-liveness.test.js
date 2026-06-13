/**
 * tms-liveness.test.js
 * --------------------
 * 纯逻辑单测：node --test examples/TMS/js/tms-liveness.test.js
 * 覆盖 VLM 活体核验的提示词消息体构造与 verdict 解析（稳健性）。
 *
 * 注意：浏览器抓帧 / fetch / LM Studio 推理不在此测，由 curl 端到端 + 浏览器烟测覆盖。
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('./tms-liveness.js');

test('buildMessages: 一条 user 消息，含提示词 + N 张图', () => {
    const frames = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'];
    const msgs = L.buildMessages(frames, 'PROMPT');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, 'user');
    assert.strictEqual(msgs[0].content[0].type, 'text');
    assert.strictEqual(msgs[0].content[0].text, 'PROMPT');
    assert.strictEqual(msgs[0].content.length, 1 + frames.length);
    assert.strictEqual(msgs[0].content[1].type, 'image_url');
    assert.strictEqual(msgs[0].content[1].image_url.url, frames[0]);
    assert.strictEqual(msgs[0].content[2].image_url.url, frames[1]);
});

test('buildMessages: 0 帧也合法（只有提示词）', () => {
    const msgs = L.buildMessages([], 'P');
    assert.strictEqual(msgs[0].content.length, 1);
});

test('parseVerdict: 纯 JSON', () => {
    const v = L.parseVerdict('{"real": true, "confidence": 0.92, "reason": "live human"}');
    assert.strictEqual(v.real, true);
    assert.ok(Math.abs(v.confidence - 0.92) < 1e-9);
    assert.strictEqual(v.reason, 'live human');
});

test('parseVerdict: 前后有多余文字也能抠出 JSON', () => {
    const v = L.parseVerdict('Sure! Here is my answer:\n{"real": false, "confidence": 0.1, "reason": "phone screen"}\nThanks.');
    assert.strictEqual(v.real, false);
    assert.ok(Math.abs(v.confidence - 0.1) < 1e-9);
    assert.strictEqual(v.reason, 'phone screen');
});

test('parseVerdict: real 为字符串 "yes"/"true" 也认', () => {
    assert.strictEqual(L.parseVerdict('{"real":"yes","confidence":0.8}').real, true);
    assert.strictEqual(L.parseVerdict('{"real":"false","confidence":0.8}').real, false);
    assert.strictEqual(L.parseVerdict('{"real":"no"}').real, false);
});

test('parseVerdict: confidence 缺失/非法 → 按 real 兜底并夹到 [0,1]', () => {
    assert.strictEqual(L.parseVerdict('{"real":true}').confidence, 1);
    assert.strictEqual(L.parseVerdict('{"real":false}').confidence, 0);
    assert.strictEqual(L.parseVerdict('{"real":true,"confidence":5}').confidence, 1);   // 夹断
    assert.strictEqual(L.parseVerdict('{"real":false,"confidence":-2}').confidence, 0);
    assert.strictEqual(L.parseVerdict('{"real":true,"confidence":"abc"}').confidence, 1);
});

test('parseVerdict: 无 JSON / 空 / 非对象 → null', () => {
    assert.strictEqual(L.parseVerdict('I think this is a real person.'), null);
    assert.strictEqual(L.parseVerdict(''), null);
    assert.strictEqual(L.parseVerdict(null), null);
    assert.strictEqual(L.parseVerdict('[1,2,3]'), null);   // 数组不是 verdict 对象（无 real）
});

test('parseVerdict: reason 截断到 200 字', () => {
    const long = 'x'.repeat(500);
    const v = L.parseVerdict('{"real":true,"confidence":0.9,"reason":"' + long + '"}');
    assert.strictEqual(v.reason.length, 200);
});

test('VlmLiveness: 默认配置 + endpoint 去尾斜杠', () => {
    const e = new L.VlmLiveness();
    assert.strictEqual(e.endpoint, 'http://127.0.0.1:6501/v1');
    assert.strictEqual(e.model, 'minicpm-v-4.6');
    assert.strictEqual(e.ready, false);
    const e2 = new L.VlmLiveness({ endpoint: 'http://x:1/v1/', model: 'm', threshold: 0.7 });
    assert.strictEqual(e2.endpoint, 'http://x:1/v1');   // 去掉尾部 /
    assert.strictEqual(e2.threshold, 0.7);
});
