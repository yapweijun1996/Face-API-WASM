# Face-API-WASM Face Recognition System

A high-performance, browser-based face recognition system built with [face-api.js](https://github.com/vladmandic/face-api) and TensorFlow.js WASM backend. This project demonstrates real-time face registration and verification with a modern UI.

## 🚀 Features

- **WASM Powered**: Utilizes the TensorFlow.js WebAssembly backend for near-native performance in the browser.
- **Face Registration**: 
  - Capture multiple face samples (20 frames) to build a robust user profile.
  - Automatic quality checks (similarity and consistency thresholds).
  - Saves data locally using **IndexedDB**.
  - Option to export registered data as JSON.
- **Face Verification**:
  - Real-time 1:N identity matching.
  - Supports loading users from IndexedDB or JSON file upload.
  - Configurable matching thresholds for security vs. convenience.
- **Modern UI/UX**:
  - Dark mode aesthetic with responsive design.
  - Real-time visual feedback (bounding boxes, landmarks, progress bars).
  - "Warm-up" mechanism to ensure smooth first-time detection.

## 📂 Project Structure

- **`home.html`**: Main landing page with navigation.
- **`index.html`**: Quick technical demo ensuring WASM backend and models are loaded correctly.
- **`face_register.html`**: User registration interface. Captures face descriptors and saves them.
- **`face_verify.html`**: Identity verification interface. Matches live video against registered profiles.
- **`face_verify_adhoc.html`**: Quick demo - upload reference photos and verify with webcam (no registration required).
- **`face_verify_image.html`**: Image verification - upload photos to verify against registered users.
- **`settings.html`**: Configuration and data management.
- **`js/lib/`**: Local JavaScript libraries (offline-ready):
  - `tf.min.js`: TensorFlow.js core library
  - `tf-backend-wasm.js`: TensorFlow.js WASM backend
  - `tfjs-backend-wasm*.wasm`: WASM binary files
  - `face-api.js`: Face-API.js library
- **`models/`**: Pre-trained model files (offline-ready):
  - `tiny_face_detector_model.*`: Fast face detector
  - `ssd_mobilenetv1_model.*`: Accurate face detector
  - `face_landmark_68_model.*`: Facial landmark detector
  - `face_recognition_model.*`: Face descriptor generator
- **`js/core/`**: Core logic modules:
  - `FaceRegistrationManager.js`: Handles the logic for capturing and validating face samples.
  - `FaceMatcher.js`: Handles the logic for comparing face descriptors.
  - `FaceStorage.js`: Manages IndexedDB operations.

## 📦 Offline Support

All JavaScript libraries and model files are bundled locally, so the application works without internet connectivity. No external CDN requests are required.

## 🛠️ Usage

### 1. Setup
No build step is required. Serve the files using a static server (e.g., Live Server in VS Code, Python `http.server`, or any web server).
> **Note**: Access to the camera requires the site to be served via `localhost` or `https`.

### 2. Registration
1. Navigate to **Face Registration** (`face_register.html`).
2. Enter a **User ID** and **Name**.
3. Click **Start Registration**.
4. Face the camera and slightly move your head to capture different angles until the progress bar reaches 100%.

### 3. Verification
1. Navigate to **Face Verification** (`face_verify.html`).
2. Select **IndexedDB** as the data source (default).
3. The system will load registered users.
4. Click **Start Verification** to begin real-time matching.

## ⚙️ Configuration
Key parameters can be adjusted in the `<script>` sections of the HTML files:
- `inputSize`: Resolution of the processing image (default 320). Higher values = better accuracy but higher CPU/GPU usage.
- `scoreThreshold`: Minimum confidence to detect a face (0.0 - 1.0).
- `matchThreshold`: Maximum distance for a valid match (default 0.6). Lower is stricter.

## 📦 Dependencies
- [TensorFlow.js](https://www.tensorflow.org/js)
- [face-api.js](https://github.com/vladmandic/face-api)

## 📄 License
MIT
