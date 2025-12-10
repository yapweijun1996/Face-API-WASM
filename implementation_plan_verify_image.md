# Implementation Plan - Face Verification by Single Avatar Picture

本计划旨在添加一个新的功能：允许用户上传一张静态图片（头像），并将其与已注册的人脸数据进行比对验证。

## 1. 目标 (Objectives)
- 在首页 (`home.html`) 添加新的功能入口卡片。
- 创建新的验证页面 (`face_verify_image.html`)。
- 实现图片上传、人脸检测及与现有注册数据的比对逻辑。
- 保持现有的 UI 风格和用户体验。

## 2. 详细步骤 (Detailed Steps)

### Step 1: 创建新页面 `face_verify_image.html`
- **基础结构**: 复制 `face_verify.html` 作为模板，保留头部引用（FaceAPI, WASM, CSS）。
- **UI 修改**:
  - 移除 `<video>` 相关的元素和逻辑。
  - 添加 **拖拽/上传区域** (Dropzone)，允许用户上传图片 (`.jpg`, `.png`).
  - 添加 **图片预览区域**，用于显示上传的图片及在人脸位置绘制检测框。
  - 保留 **控制面板** (`#controlPanel`)，用于选择数据源（IndexedDB 或 JSON 文件），这部分逻辑可以完全复用。
- **逻辑实现**:
  - **图片处理**: 监听文件输入 `change` 事件，读取文件并显示在 `<img>` 标签中。
  - **人脸检测**: 使用 `faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor()` 对上传的图片进行检测。
  - **人脸比对**: 获取 descriptor 后，调用 `faceMatcher.findBestMatch(descriptor)`。
  - **结果展示**: 在图片上绘制人脸框，并在下方显示匹配结果（姓名、置信度）。

### Step 2: 修改首页 `home.html`
- 在 `.card-grid` 中添加一个新的卡片。
- **标题**: "Image Verification" (或类似)。
- **图标**: 使用合适的 emoji (如 🖼️)。
- **描述**: "Upload a single photo to verify identity."
- **链接**: 指向 `face_verify_image.html`。

### Step 3: 复用与调整逻辑
- **FaceMatcher.js**: 现有的 `findBestMatch` 方法接受 descriptor，完全可以直接复用，无需修改核心逻辑。
- **FaceStorage.js**: 负责加载数据，同样可以直接复用。

## 3. 验证 (Verification)
1. 打开 `home.html`，确认新卡片显示正常。
2. 点击卡片进入 `face_verify_image.html`。
3. 加载数据源 (IndexedDB)。
4. 上传一张已注册用户的照片。
5. 确认系统能正确识别并显示 "Matched: [Name]"。
6. 上传一张未注册用户的照片，确认显示 "Unknown"。

## 4. 后续优化 (Future Improvements)
- 支持多张人脸检测（如果上传的图片有多人）。
- 允许裁剪图片。
