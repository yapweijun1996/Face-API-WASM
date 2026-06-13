/**
 * tms-liveness.js
 * ---------------
 * 视觉大模型（VLM）活体核验 —— MiniCPM-V 经 LM Studio 本地服务。
 *
 *   打卡时连续抓 N 帧（设置页可调，默认 6 张 / 0.5 秒间隔），整帧（非裁剪）发给本地 MiniCPM-V，
 *   让它判断「这是真人在场，还是伪造（照片 / 手机或屏幕里的人脸或视频 / 打印件 / 面具）」。
 *
 *   相比小型纹理模型（MiniFASNet），VLM 看的是**整帧上下文**：能直接发现
 *   「有只手举着手机、屏幕有边框/反光、人脸只占画面里一个小矩形」——这正是
 *   手机屏幕重放最容易暴露的破绽。
 *
 *   放行条件：VLM 判 real=true 且 confidence ≥ 阈值。
 *
 * ⚠️ 诚实声明：
 *   - 依赖本机 LM Studio 在跑且已加载视觉模型；服务不可达时**降级放行**（不锁死打卡），
 *     仅提示「核验不可用」——这意味着此时没有防伪，按需可改为失败即拒。
 *   - VLM 判别比小模型强，但仍非认证级 PAD，也无法保证挡住高水平 Deepfake；
 *     务必用你自己的真人 / 照片 / 屏幕样本验证后再依赖。
 *   - 全程只发往本机 localhost 的 LM Studio，不出网。
 *
 * 设计：纯逻辑（提示词、消息体构造、verdict 解析）可在 Node 单测；
 *       浏览器运行时（抓帧 / fetch）封装在类里。
 */

(function (root) {
    'use strict';

    // ============================================================
    // 纯逻辑（浏览器 + Node 共用，单测覆盖）
    // ============================================================
    const VLM_PROMPT_VERSION = 'vlm-spoof-cues-v2';

    /** 发给 VLM 的活体判别提示词。要求严格 JSON，便于稳定解析。 */
    const VLM_PROMPT =
        'You are a presentation-attack-detection (liveness) checker for a face attendance kiosk. ' +
        'Use a SECURITY-FIRST policy: one clear spoof cue is enough to mark SPOOF, even if the face looks realistic. ' +
        'You are given several FULL webcam frames over a short configurable time window, not cropped face images, of the person trying to clock in. ' +
        'Decide if this is a GENUINE LIVE PERSON physically present in front of the camera, ' +
        'or a SPOOF: a photo, a phone/tablet/computer screen showing a face or video, a printed picture, or a mask. ' +
        'Inspect EVERY frame, especially corners and edges. Strong spoof cues: ANY visible phone/tablet/laptop, device bezel, or rectangular screen boundary; ' +
        'a hand or fingers holding a display or printed photo; paper/photo edges, curled paper, flat card borders, or mask edges; ' +
        'screen glare, specular reflection, moire, pixel-grid or RGB subpixel artifacts; inconsistent lighting between the face and background; ' +
        'multiple frames showing a static flat image instead of a live person in 3D space; or a face close-up that fills the frame and hides context. ' +
        'If a phone or screen is visible anywhere in any frame, set real=false, attack_type="phone_screen", and include that cue. ' +
        'Do NOT mark real just because the indoor background is consistent or the face is clear. ' +
        'If the surroundings are not visible enough to rule out a phone/photo, set uncertain=true and real=false. ' +
        'Reply with STRICT JSON only, no extra text: ' +
        '{"real": true or false, "confidence": a number 0.0-1.0, "attack_type": "phone_screen|printed_photo|video_replay|mask|unknown|none", "spoof_cues": ["short cue"], "uncertain": true or false, "reason": "<short reason>"}. ' +
        'Set real=true only if you are confident it is a live, in-person human.';

    /**
     * 构造 OpenAI 兼容的 messages（一条 user 消息：提示词 + N 张图）。
     * @param {string[]} frames dataURL 数组
     * @param {string} prompt
     */
    function buildMessages(frames, prompt) {
        const content = [{ type: 'text', text: prompt }];
        (frames || []).forEach(f => content.push({ type: 'image_url', image_url: { url: f } }));
        return [{ role: 'user', content }];
    }

    function normalizeReviewMode(mode) {
        const m = String(mode || '').trim();
        return (m === 'session6' || m === 'single6') ? m : 'batch6';
    }

    function framePrompt(index, total, priorVerdicts) {
        const history = (priorVerdicts || []).map((v, i) => {
            const cues = Array.isArray(v.spoof_cues) && v.spoof_cues.length ? v.spoof_cues.join(', ') : 'none';
            return `frame ${i + 1}: real=${!!v.real}, confidence=${Number(v.confidence || 0).toFixed(2)}, attack_type=${v.attack_type || 'unknown'}, uncertain=${!!v.uncertain}, cues=${cues}`;
        }).join('; ');
        return VLM_PROMPT +
            ` This is frame ${index + 1} of ${total}. Check ONLY this new frame visually, but use this prior verdict history for continuity: ${history || 'none'}. ` +
            'If this frame has any spoof cue, return real=false even if prior frames looked real.';
    }

    function buildFrameMessages(frame, index, total, priorVerdicts) {
        return buildMessages([frame], framePrompt(index, total, priorVerdicts));
    }

    function aggregateFrameVerdicts(verdicts, mode) {
        const list = (verdicts || []).filter(Boolean);
        if (!list.length) return null;
        const badIndex = list.findIndex(v => !v.real || !!v.uncertain);
        if (badIndex >= 0) {
            const v = list[badIndex];
            return {
                ...v,
                real: false,
                confidence: Number(v.confidence) || 0,
                reason: `frame ${badIndex + 1}/${list.length}: ${v.reason || 'suspect frame'}`.slice(0, 200),
                frameVerdicts: list,
                review_mode: normalizeReviewMode(mode)
            };
        }
        const minConfidence = Math.min(...list.map(v => Number(v.confidence) || 0));
        return {
            real: true,
            confidence: Math.max(0, Math.min(1, minConfidence)),
            attack_type: 'none',
            spoof_cues: [],
            uncertain: false,
            reason: `all ${list.length} frames passed ${normalizeReviewMode(mode)} review`,
            frameVerdicts: list,
            review_mode: normalizeReviewMode(mode)
        };
    }

    /**
     * 抓视频整帧 → 下采样 JPEG dataURL（保留上下文，给 VLM 看整画面）。
     * 纯运行时工具：不依赖 LM Studio，可在健康检查未完成时就用来填滚动缓冲。
     * @param {HTMLVideoElement} video
     * @param {{maxEdge?:number, jpegQuality?:number, canvas?:HTMLCanvasElement}} [opts]
     *        canvas 可由调用方复用，避免每帧 new 一个 canvas。
     * @returns {string|null} dataURL，视频尚无尺寸时返回 null
     */
    function captureVideoFrame(video, opts) {
        const o = opts || {};
        const maxEdge = o.maxEdge != null ? o.maxEdge : 512;
        const jpegQuality = o.jpegQuality != null ? o.jpegQuality : 0.7;
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return null;
        const scale = Math.min(1, maxEdge / Math.max(vw, vh));
        const w = Math.max(1, Math.round(vw * scale));
        const h = Math.max(1, Math.round(vh * scale));
        const cvs = o.canvas || document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        cvs.getContext('2d').drawImage(video, 0, 0, w, h);
        return cvs.toDataURL('image/jpeg', jpegQuality);
    }

    /**
     * 从模型回复里稳健解析 verdict。容忍前后多余文字、real 为字符串、confidence 缺失。
     * @returns {{real:boolean, confidence:number, attack_type:string, spoof_cues:string[], uncertain:boolean, reason:string}|null} 无法解析返回 null
     */
    function parseVerdict(text) {
        if (!text || typeof text !== 'string') return null;
        const m = text.match(/\{[\s\S]*\}/);   // 第一个 {...} 块
        if (!m) return null;
        let o;
        try { o = JSON.parse(m[0]); } catch (e) { return null; }
        if (o == null || typeof o !== 'object') return null;

        let real = o.real;
        if (typeof real === 'string') real = /^(true|yes|1|live|real)$/i.test(real.trim());
        else real = !!real;

        let c = Number(o.confidence);
        if (!isFinite(c)) c = real ? 1 : 0;
        c = Math.max(0, Math.min(1, c));

        const allowedAttackTypes = new Set(['phone_screen', 'printed_photo', 'video_replay', 'mask', 'unknown', 'none']);
        const attackType = allowedAttackTypes.has(String(o.attack_type || '').trim())
            ? String(o.attack_type).trim()
            : 'unknown';
        const spoofCues = Array.isArray(o.spoof_cues)
            ? o.spoof_cues.map(x => String(x).trim()).filter(Boolean).slice(0, 8).map(x => x.slice(0, 80))
            : [];
        let uncertain = o.uncertain;
        if (typeof uncertain === 'string') uncertain = /^(true|yes|1|uncertain|maybe)$/i.test(uncertain.trim());
        else uncertain = !!uncertain;

        return {
            real: real,
            confidence: c,
            attack_type: attackType,
            spoof_cues: spoofCues,
            uncertain,
            reason: String(o.reason == null ? '' : o.reason).slice(0, 200)
        };
    }

    // ============================================================
    // 浏览器运行时：VLM 客户端
    // ============================================================
    class VlmLiveness {
        constructor(opts) {
            const o = opts || {};
            // endpoint 为 OpenAI 兼容前缀，如 http://127.0.0.1:6501/v1
            this.endpoint = (o.endpoint || 'http://127.0.0.1:6501/v1').replace(/\/$/, '');
            this.model = o.model || 'minicpm-v-4.6';
            this.threshold = o.threshold != null ? o.threshold : 0.5;
            this.timeoutMs = o.timeoutMs != null ? o.timeoutMs : 60000;
            this.maxEdge = o.maxEdge != null ? o.maxEdge : 512;   // 抓帧下采样最长边
            this.jpegQuality = o.jpegQuality != null ? o.jpegQuality : 0.7;
            this.ready = false;
            this._cvs = null;
        }

        /** 健康检查：GET /models 看 LM Studio 是否在跑。成功置 ready=true。 */
        async health() {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 5000);
                const res = await fetch(this.endpoint + '/models', { signal: ctrl.signal });
                clearTimeout(t);
                this.ready = !!(res && res.ok);
            } catch (e) {
                this.ready = false;
            }
            return this.ready;
        }

        /** 抓当前视频帧 → 下采样 JPEG dataURL（整帧，保留上下文）。 */
        captureFrame(video) {
            if (!this._cvs) this._cvs = document.createElement('canvas');
            return captureVideoFrame(video, { maxEdge: this.maxEdge, jpegQuality: this.jpegQuality, canvas: this._cvs });
        }

        /**
         * 把 N 帧发给 MiniCPM-V，返回活体判定。
         * @param {string[]} frames dataURL 数组
         * @returns {Promise<{real:boolean, confidence:number, reason:string, raw:string}>}
         */
        async verify(frames) {
            const messages = buildMessages(frames, VLM_PROMPT);
            return this.request(messages);
        }

        async request(messages) {
            const body = {
                model: this.model,
                temperature: 0,
                max_tokens: 200,
                messages
            };
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
            try {
                const res = await fetch(this.endpoint + '/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ctrl.signal
                });
                if (!res.ok) throw new Error('LM Studio HTTP ' + res.status);
                const j = await res.json();
                const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
                const v = parseVerdict(txt);
                if (!v) throw new Error('unparseable verdict: ' + String(txt).slice(0, 100));
                v.raw = txt;
                return v;
            } finally {
                clearTimeout(t);
            }
        }

        async verifyFramesIndependently(frames) {
            const verdicts = [];
            for (let i = 0; i < (frames || []).length; i++) {
                const v = await this.request(buildFrameMessages(frames[i], i, frames.length, []));
                verdicts.push(v);
                if (!v.real || v.uncertain) break;
            }
            return aggregateFrameVerdicts(verdicts, 'single6');
        }

        async verifyFramesInSession(frames) {
            const verdicts = [];
            for (let i = 0; i < (frames || []).length; i++) {
                const v = await this.request(buildFrameMessages(frames[i], i, frames.length, verdicts));
                verdicts.push(v);
                if (!v.real || v.uncertain) break;
            }
            return aggregateFrameVerdicts(verdicts, 'session6');
        }

        async verifyWithStrategy(frames, mode) {
            const reviewMode = normalizeReviewMode(mode);
            if (reviewMode === 'single6') return this.verifyFramesIndependently(frames);
            if (reviewMode === 'session6') return this.verifyFramesInSession(frames);
            const v = await this.verify(frames);
            v.review_mode = 'batch6';
            return v;
        }
    }

    // ============================================================
    // 导出
    // ============================================================
    const api = { VLM_PROMPT_VERSION, VLM_PROMPT, buildMessages, buildFrameMessages, aggregateFrameVerdicts, normalizeReviewMode, parseVerdict, captureVideoFrame, VlmLiveness };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TmsLiveness = api;

})(typeof self !== 'undefined' ? self : this);
