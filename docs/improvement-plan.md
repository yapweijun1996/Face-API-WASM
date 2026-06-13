# Face-API-WASM — Improvement Plan

Reviewed 2026-06-13. Findings based on codebase audit + research into face-api.js (vladmandic fork), TF.js WASM backend, and liveness detection state-of-the-art.

---

## P0 — Bugs / Production Leaks (fix now)

### P0-1: Remove production debug log in FaceMatcher.js
**File:** `js/core/FaceMatcher.js:209`  
**Issue:** `console.log('🔍 Match Debug: ...')` fires on every single face match in production. At 10–15 fps this is thousands of log lines per minute, measurably slowing the browser console and leaking distance values.  
**Fix:** Delete or gate behind a `debug` config flag. ✅ Fixed in this session.

---

## P1 — High Impact, Low Risk

### P1-1: WASM Threading — Add COOP/COEP Server Headers
**Issue:** The three WASM binaries are already bundled (`tfjs-backend-wasm.wasm`, `*-simd.wasm`, `*-threaded-simd.wasm`). TF.js auto-selects the best one — but **threaded SIMD requires `SharedArrayBuffer`**, which browsers block unless the page is served with:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Without these, inference silently falls back to SIMD-only.  
**Measured impact (TF.js blog):** SIMD alone = 1.7–4.5× over plain WASM; threading adds another 1.8–2.9× on top.  
**Fix:** Configure your static server to emit these headers. Example for Python:
```python
# serve.py
from http.server import HTTPServer, SimpleHTTPRequestHandler
class COOPHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()
HTTPServer(('', 8080), COOPHandler).serve_forever()
```
⚠️ COEP breaks cross-origin iframes/images without explicit `crossorigin` attributes. Verify no CDN assets exist (this project is already fully offline — safe to enable).

### P1-2: Debounce `_saveProgress` IDB Writes
**File:** `js/core/FaceRegistrationManager.js:200–201`  
**Issue:** `_saveProgress()` is called on **every accepted frame** (up to 20 times, each 500ms). Each call opens a new IndexedDB transaction. While not catastrophically slow, it's noisy and risks write-queue buildup on slow devices.  
**Fix:** Debounce with 200ms delay — saves progress after activity stops, not mid-burst:
```js
_scheduleSaveProgress() {
    clearTimeout(this._saveDebounceTimer);
    this._saveDebounceTimer = setTimeout(() => this._saveProgress(), 200);
}
```
Replace `this._saveProgress()` calls with `this._scheduleSaveProgress()`.

### P1-3: Add FPS / Inference Time Display (Developer Mode)
**Issue:** No runtime performance visibility. Hard to tune `inputSize` or diagnose slow devices.  
**Fix:** Display a rolling FPS counter and inference time (already tracked in `FaceMatcher.stats.lastMatchTime`) in the overlay. Gate behind `?debug=1` URL param to keep production UI clean.

---

## P2 — Accuracy / Security Improvements

### P2-1: Threshold Guidance — FAR vs FRR Tradeoff
**Current:** `matchThreshold = 0.6` (face-api.js canonical default).  
**Context:** This threshold controls the **False Accept Rate (FAR)** vs **False Reject Rate (FRR)** tradeoff:
- Lower threshold (e.g. 0.45) → stricter, fewer false accepts, more false rejects (user must be closer/better lit)
- Higher threshold (e.g. 0.65) → more permissive, more false accepts

**Recommended tuning by use-case:**

| Use-case | Suggested `matchThreshold` | Notes |
|---|---|---|
| Time & attendance (TMS) | 0.50–0.55 | Balance security + daily convenience |
| High-security access control | 0.40–0.45 | Expect some false rejects |
| Demo / prototype | 0.6 (default) | Fine for testing |

**Never change threshold without re-testing** against your own user population — FAR/FRR depends on camera quality, lighting, and demographic distribution.

### P2-2: Multi-Cluster Descriptors for Pose Diversity
**Current:** Registration stores all 20 sample descriptors but matching uses only `meanDescriptor` (average of all 20).  
**Problem:** The mean of front-face + side-face + slightly-tilted may not accurately represent any single pose. A user registered only in frontal view may fail verification at an angle.  
**Fix:** Store 2–3 descriptor "anchors" using k-means on the 20 samples (trivial at this scale — 20 points in 128-d). Match against all anchors and take the minimum distance.  
**Note:** Linear scan at 128-d remains the right strategy regardless of user count. Tree-based indexes (k-d, ball-tree) degrade to linear above ~20 dimensions (curse of dimensionality). For fleets with 10,000+ enrolled users, consider approximate-nearest-neighbor libraries (HNSW/FAISS-WASM).

### P2-3: Model Selection — TinyFaceDetector for Mobile
**Current:** `ssd_mobilenetv1_model` (~5.4 MB) is used everywhere.  
**Context:**
- `ssd_mobilenetv1`: higher accuracy, slower (~5.4 MB model)
- `tiny_face_detector`: smaller (~190 KB), 2–3× faster, slightly less accurate on small/distant faces

**Recommendation:** Auto-detect device class at startup and select accordingly:
```js
const isLowEnd = navigator.hardwareConcurrency <= 4 || /Mobi/.test(navigator.userAgent);
const detector = isLowEnd ? new faceapi.TinyFaceDetectorOptions({ inputSize: 224 })
                          : new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
```

### P2-4: `inputSize` Tuning Guide
`inputSize` is the resolution at which the image is processed before detection.

| `inputSize` | Speed | Accuracy | Best for |
|---|---|---|---|
| 160 | Fastest | Low | Mobile, distant face OK |
| 224 | Fast | Medium | TinyFaceDetector default |
| 320 | Medium | Good | SSD default ✅ current |
| 416 | Slow | Higher | High-accuracy requirements |
| 608 | Slowest | Highest | Static images |

For real-time video (30 fps target), 320 is the right balance. Drop to 224 on mobile.

---

## P3 — Architecture / Future Enhancements

### P3-1: IndexedDB Schema Versioning
**File:** `js/core/FaceStorage.js:9` — `DB_VERSION = 1`  
**Issue:** No migration logic in `onupgradeneeded` beyond initial creation. Adding new fields (e.g. descriptor clusters in P2-2) requires bumping `DB_VERSION` and writing a migration.  
**Fix:** Plan migrations before adding schema changes. Template:
```js
request.onupgradeneeded = (event) => {
    const db = event.target.result;
    const oldVersion = event.oldVersion;
    if (oldVersion < 1) { /* initial schema */ }
    if (oldVersion < 2) { /* add clusters index */ }
};
```

### P3-2: WebGL Backend Fallback is Already Wired
**Observation:** Each page already has:
```js
await faceapi.tf.setBackend('webgl'); // fallback if WASM unavailable
```
This is good. No change needed.

### P3-3: Liveness Detection — VLM Approach (Already Implemented)
**File:** `examples/TMS/js/tms-liveness.js`  
**Status:** ✅ Implemented — MiniCPM-V via LM Studio (local, no network egress).  
**Honest caveats (already documented in the file):**
- Falls back to "pass" if LM Studio is unreachable — acceptable for attendance; change if used for access control
- Not certified PAD-level; won't stop high-quality Deepfake
- Best defense against replay attacks (phone screen, printed photo) — which is the most common real-world threat

**⛔ MiniFASNet — BANNED (tested 2026-06-14, does not work).** MiniFASNet was previously suggested as a lightweight client-side FAS fallback. It was tested and **does not work at all** in this browser/WASM setting — do not re-recommend or re-attempt it. The VLM check (MiniCPM-V via LM Studio) is the only sanctioned liveness path. If an offline client-side fallback is needed in future, evaluate other approaches from scratch and validate on real spoof samples before adopting — **not MiniFASNet**.

**⛔ Random action challenge — BANNED (decided 2026-06-14).** Do not add or recommend blink / smile / mouth-open / turn-left / turn-right / nod / random gesture challenge-response flows for this project. They add user friction, slow attendance, are awkward during peak clock-in, and still do not reliably stop prepared replay/deepfake attacks. For this repo, anti-spoofing work should stay on passive full-frame VLM review, face-framing/context capture, deferred HR review, and/or a certified PAD SDK/service if stronger assurance is required.

---

## Summary Table

| ID | Priority | Effort | Implemented? |
|---|---|---|---|
| P0-1 Debug log removal | P0 | Minutes | ✅ Done |
| P1-1 COOP/COEP headers | P1 | Minutes (server config) | ✅ Done (`serve.py`, browser-verified `crossOriginIsolated:true`) |
| P1-2 IDB debounce | P1 | 30 min | ✅ Done (`FaceRegistrationManager._scheduleSaveProgress`, unit-tested) |
| P1-3 FPS display | P1 | 1 hr | ✅ Done (`PerfOverlay.js`, `?debug=1`, unit-tested) |
| P2-1 Threshold guide | P2 | Docs only | ✅ This doc |
| P2-2 Multi-cluster descriptors | P2 | 2–3 hrs | ✅ Done (`computeKMeans`, backward-compat, e2e-verified) |
| P2-3 Model auto-select | P2 | 1 hr | ✅ Done (`DeviceProfile.recommendDetectorModel`, wired into 4 HTML) |
| P2-4 inputSize guide | P2 | Docs only | ✅ This doc |
| P3-1 IDB versioning | P3 | Pre-plan only | ❌ Future (clusters stored as optional field — no migration needed yet) |
| ~~P3-3 MiniFASNet liveness~~ | ~~P3~~ | — | ⛔ BANNED — tested 2026-06-14, does not work. Do not re-attempt. |
| ~~Random action challenge liveness~~ | ~~P3~~ | — | ⛔ BANNED — decided 2026-06-14. Do not implement blink/gesture/head-turn challenge flows. |

---

## Implemented This Session — Details

### P1-2 Debounce (`js/core/FaceRegistrationManager.js`)
- `_scheduleSaveProgress()` debounces IDB writes by `saveProgressDebounceMs` (default 200ms).
- `_cancelScheduledSave()` is called in `cancel()` and `_finalize()` **before** `clearProgress()` — prevents a pending debounced write from resurrecting just-cleared progress (race guard).
- Falls back to immediate write if `saveProgressDebounceMs <= 0`.

### P2-2 Multi-cluster Descriptors
- `computeKMeans(descriptors, k)` — deterministic k-means (k=3 default), pure/testable.
- `_finalize()` computes `descriptorClusters` alongside `meanDescriptor` (both stored).
- `FaceMatcher._processUsers` priority: **clusters → meanDescriptor → all raw frames**. Old records without clusters fall back to mean automatically — fully backward-compatible.
- `FaceStorage` export/import round-trips `descriptorClusters` (validated, null-safe).
- **No IDB migration needed**: clusters are an additive optional field; `DB_VERSION` stays 1.

### P2-3 Auto Model Selection (`js/core/DeviceProfile.js`)
- `recommendDetectorModel(nav)` → `'tiny'` for mobile / ≤4 cores / ≤4GB RAM, else `'ssd'`.
- Wired as the **default** in `face_register`, `face_verify`, `face_verify_image`, `face_verify_adhoc`.
- **Explicit user setting always wins** — auto only fills the default when nothing is saved.

### Tests
- `js/core/core.test.js` — 16 unit tests (`node --test js/core/core.test.js`). Covers k-means, matcher cluster consumption, device recommendation, debounce + cancel race guard.
- All 25 tests pass (16 core + 9 liveness).
