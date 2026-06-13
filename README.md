# Face-API-WASM Face Recognition System

A high-performance, browser-based face recognition system built with [face-api.js](https://github.com/vladmandic/face-api) (vladmandic fork) and TensorFlow.js WASM backend. Fully offline — no build step, no cloud API.

## Features

- **WASM Powered**: TF.js WebAssembly backend with auto-detection of SIMD and multi-threading support.
- **Face Registration**: Captures 20 diverse face samples with quality + consistency checks. Saves to IndexedDB with optional JSON export.
- **Face Verification**: Real-time 1:N identity matching against registered users.
- **Image Verification**: Upload a photo to match against registered profiles.
- **Ad-hoc Mode**: Upload reference photos + verify with webcam (no registration required).
- **Liveness Detection** *(TMS example)*: VLM-based anti-spoofing via local MiniCPM-V through LM Studio. Detects phone replay, printed photos, and screen-based spoofing.
- **Offline First**: All JS libraries and model files are bundled locally. No CDN, no internet required.
- **PWA / TMS Example**: Full Time & Attendance app (`examples/TMS/`) demonstrating production usage.

---

## Project Structure

```
Face-API-WASM/
├── home.html                  # Landing page with navigation
├── index.html                 # Technical demo: WASM backend + model loading
├── face_register.html         # Face registration UI
├── face_verify.html           # 1:N real-time verification
├── face_verify_adhoc.html     # Ad-hoc: upload reference + verify
├── face_verify_image.html     # Image-based verification
├── settings.html              # Data management (import/export/delete)
│
├── js/
│   ├── core/
│   │   ├── FaceMatcher.js            # 1:N matching logic
│   │   ├── FaceStorage.js            # IndexedDB CRUD + JSON import/export
│   │   └── FaceRegistrationManager.js # State-machine for registration flow
│   └── lib/                          # Bundled libraries (offline)
│       ├── tf.min.js                 # TensorFlow.js core
│       ├── tf-backend-wasm.js        # WASM backend loader
│       ├── tfjs-backend-wasm.wasm            # Plain WASM
│       ├── tfjs-backend-wasm-simd.wasm       # SIMD-accelerated WASM
│       ├── tfjs-backend-wasm-threaded-simd.wasm  # SIMD + multi-thread
│       ├── face-api.js               # face-api.js IIFE bundle
│       └── face-api.esm-nobundle.js  # ESM build (no TF.js included)
│
├── models/
│   ├── tiny_face_detector_model.*    # Fast detector (190 KB)
│   ├── ssd_mobilenetv1_model.*       # Accurate detector (5.4 MB)
│   ├── face_landmark_68_model.*      # 68-point landmark detection
│   └── face_recognition_model.*      # 128-d face descriptor
│
├── examples/
│   └── TMS/                          # Time & Attendance System example
│       ├── js/tms-liveness.js        # VLM liveness detection (MiniCPM-V)
│       ├── js/tms-app.js             # Main app logic
│       ├── js/tms-db.js              # IndexedDB for attendance records
│       └── js/tms-tracker.js         # Clock-in/out tracker
│
└── docs/
    └── improvement-plan.md           # Prioritized improvement roadmap
```

---

## Setup

No build step required. Serve files from a static server.

> **Camera access requires `localhost` or `https`.**

```bash
# Python 3
python3 -m http.server 8080

# Node.js (npx)
npx serve .
```

Then open `http://localhost:8080/home.html`.

### Enabling WASM Multi-threading (Recommended)

All three WASM binaries are bundled. TF.js auto-selects the best one — but **threaded SIMD requires `SharedArrayBuffer`**, which browsers gate behind these HTTP response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them, the backend silently falls back to SIMD-only (~2–4× slower than full threading).

**Python server with COOP/COEP** (`serve.py`):

```python
from http.server import HTTPServer, SimpleHTTPRequestHandler

class COOPHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

HTTPServer(('', 8080), COOPHandler).serve_forever()
```

> This project is fully offline (no cross-origin assets), so COEP is safe to enable.

**Measured speedup (TF.js benchmark):** SIMD = 1.7–4.5× over plain WASM; threading adds another 1.8–2.9×.

---

## Registration

1. Go to **Face Registration** (`face_register.html`).
2. Enter a **User ID** and **Name**.
3. Click **Start Registration** and face the camera.
4. Slowly move your head to capture different angles — the system rejects duplicate frames.
5. Progress bar reaches 100% after 20 accepted frames. Data saves to IndexedDB automatically.

---

## Verification

1. Go to **Face Verification** (`face_verify.html`).
2. Select data source: **IndexedDB** (registered users) or **JSON File** (exported data).
3. Click **Start Verification** — matching runs in real time.

---

## Configuration

Key parameters appear in the `<script>` sections of each HTML page.

### Detector Options

| Parameter | Default | Effect |
|---|---|---|
| `inputSize` | `320` | Processing resolution. Higher = more accurate, slower. |
| `scoreThreshold` | `0.5` | Minimum detection confidence (0–1). |

**`inputSize` guide:**

| Value | Speed | Accuracy | Best for |
|---|---|---|---|
| 160 | Fastest | Low | Low-end mobile |
| 224 | Fast | Medium | TinyFaceDetector default |
| 320 | Balanced | Good | SSD default (current) |
| 416 | Slow | Higher | High-accuracy needs |
| 608 | Slowest | Highest | Static images only |

### Matching Options

| Parameter | Default | Effect |
|---|---|---|
| `matchThreshold` | `0.6` | Max euclidean distance to count as a match. |
| `highConfidenceThreshold` | `0.4` | Threshold for "high confidence" label. |

**Threshold tuning (FAR vs FRR tradeoff):**

| Use-case | Recommended `matchThreshold` |
|---|---|
| Time & attendance (convenience first) | 0.50–0.55 |
| Access control (security first) | 0.40–0.45 |
| Demo / prototyping | 0.6 (default) |

Lower = stricter (fewer false accepts, more false rejects). Always re-test on your own user population before changing — results vary by camera quality and lighting.

### Model Selection

| Model | Size | Speed | Accuracy | Best for |
|---|---|---|---|---|
| `ssd_mobilenetv1` | 5.4 MB | Slower | Higher | Default; desktop |
| `tiny_face_detector` | 190 KB | Faster | Lower | Mobile / low-end devices |

Auto-select by device class:
```js
const isLowEnd = navigator.hardwareConcurrency <= 4 || /Mobi/.test(navigator.userAgent);
const detectorOptions = isLowEnd
    ? new faceapi.TinyFaceDetectorOptions({ inputSize: 224 })
    : new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
```

---

## TMS Example — Time & Attendance

`examples/TMS/` is a production-grade attendance system example. Key features beyond the base system:

- **Liveness Detection** via [MiniCPM-V](https://github.com/OpenBMB/MiniCPM) (VLM) running locally on [LM Studio](https://lmstudio.ai/)
- Passive landmark geometry signal for 3D-vs-planar spoof suspicion
- Clock-in/out with face match + optional liveness gate
- PWA (installable, offline)
- i18n (English/Chinese)

### Liveness Setup

The liveness module (`js/tms-liveness.js`) calls a local LM Studio endpoint (`http://127.0.0.1:6501/v1`).

1. Install [LM Studio](https://lmstudio.ai/) and load a vision model (e.g. `minicpm-v-4.6`).
2. Start the local server in LM Studio on port 6501.
3. Clock-in attempts capture configurable full webcam frames: 3-6 images, 0.5-3s interval. The default is 6 frames at 0.5s, sent to MiniCPM-V in one request; Settings also allow one-by-one review with conversation history or independent one-frame checks.

**Graceful degradation:** If LM Studio is unreachable, liveness check is skipped and the clock-in proceeds. Change this behavior in `tms-app.js` if you need hard enforcement.

**What it detects:** Phone/tablet/screen replay, printed photos, hand-held photos. Relies on full-frame context — a hand holding a phone is a strong spoof signal. VLM verdicts include `attack_type`, `spoof_cues`, and `uncertain`; records also store a passive geometry score, selected VLM review mode, and frame sampling settings.

**What it does NOT guarantee:** High-quality 3D masks, sophisticated deepfakes. Suitable for attendance; not certified for high-security access control.

---

## Browser Compatibility

| Browser | WASM | WASM SIMD | WASM Threads | WebGL fallback |
|---|---|---|---|---|
| Chrome 91+ | ✅ | ✅ | ✅ (needs COOP/COEP) | ✅ |
| Firefox 89+ | ✅ | ✅ | ✅ (needs COOP/COEP) | ✅ |
| Safari 15+ | ✅ | ✅ | ✅ | ✅ |
| Edge 91+ | ✅ | ✅ | ✅ (needs COOP/COEP) | ✅ |
| Mobile Chrome | ✅ | ✅ | ✅ (needs COOP/COEP) | ✅ |
| Mobile Safari | ✅ | ✅ | Partial | ✅ |

---

## Architecture

```
Browser
│
├── TF.js Core (tf.min.js)
│     └── WASM Backend (tf-backend-wasm.js)
│           ├── Auto-selects: threaded-simd > simd > vanilla
│           └── Needs COOP+COEP headers for threaded-simd
│
├── face-api.js (vladmandic fork)
│     ├── Face Detection     (SSD MobileNet v1 / TinyFaceDetector)
│     ├── Landmark Detection (68-point model)
│     └── Face Recognition   (128-d descriptor model, dlib-derived)
│
├── js/core/
│     ├── FaceRegistrationManager  — state machine: IDLE→COLLECTING→COMPUTING→SAVED
│     ├── FaceMatcher              — euclidean distance 1:N matching
│     └── FaceStorage              — IndexedDB CRUD, JSON import/export
│
└── examples/TMS/
      ├── tms-liveness.js  — VLM anti-spoofing via LM Studio
      ├── tms-tracker.js   — clock-in/out state
      ├── tms-db.js        — attendance records IDB
      └── tms-app.js       — UI orchestration
```

**Why euclidean distance (not cosine)?**  
face-api.js descriptors are raw 128-d float32 vectors from a dlib-derived model. They are **not L2-normalized**. The model was trained and tuned with euclidean distance at threshold 0.6. Switching to cosine similarity would change the distance distribution and require full threshold re-calibration — not recommended without a labeled validation set.

**Why linear scan (not k-d tree or ball-tree)?**  
Tree-based nearest-neighbor indexes degrade to linear scan above ~20 dimensions (curse of dimensionality). At 128-d, linear euclidean scan is optimal for any realistic attendance user count. For 10,000+ enrolled users, consider HNSW-based approximate-nearest-neighbor (FAISS-WASM).

---

## Security Considerations

- **Spoofing**: Base system has no liveness check. Use the TMS liveness module or add your own.
- **Threshold**: Default 0.6 is suitable for demos. Tighten to 0.45–0.55 for real deployments.
- **Data export**: JSON export includes raw face descriptors. Treat exported files as sensitive — store securely, do not send over unencrypted channels.
- **Local only**: All processing is on-device. No face data is transmitted externally.
- **IDB persistence**: IndexedDB data persists until explicitly deleted. Clear it before repurposing a shared device.

---

## Dependencies

- [TensorFlow.js](https://www.tensorflow.org/js) — ML compute
- [face-api.js (vladmandic fork)](https://github.com/vladmandic/face-api) — face detection, landmark detection, face recognition

---

## Improvement Roadmap

See [`docs/improvement-plan.md`](docs/improvement-plan.md) for a prioritized list of improvements with implementation notes.

Quick summary:
- ✅ Production debug log removed (`FaceMatcher.js`)
- ✅ COOP/COEP server (`serve.py`) → unlocks WASM threading (`crossOriginIsolated` verified)
- ✅ Debounced IndexedDB progress writes in registration (200ms, race-guarded)
- ✅ Multi-cluster descriptors (k-means, k=3) for better pose diversity — backward-compatible
- ✅ Auto model selection (SSD vs TinyFaceDetector) by device class (`js/core/DeviceProfile.js`)
- ✅ FPS / inference-time / match-time dev overlay (`js/core/PerfOverlay.js`, enable with `?debug=1`)
- ⛔ MiniFASNet client-side liveness — **banned** (tested 2026-06-14, does not work). Use the VLM (LM Studio) liveness path only.
- ⛔ Random action challenge liveness — **banned** (decided 2026-06-14). Do not implement blink / smile / mouth-open / head-turn / random gesture challenge flows.
- ⛔ PIN/admin-confirm fallback — **banned** (decided 2026-06-14). Do not use PIN or manager/admin approval as anti-spoofing fallback.

Run tests: `node --test js/core/core.test.js`, `node --test examples/TMS/js/tms-liveness.test.js`, and `node --test examples/TMS/js/tms-geometry.test.js`.

**Debug overlay:** append `?debug=1` to any verify/register page URL (e.g. `face_verify.html?debug=1`) to show a live FPS / inference-ms / match-ms / backend / model panel.

---

## License

MIT
