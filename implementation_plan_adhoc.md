# Implementation Plan - Ad-hoc Face Verification (Quick Demo)

本计划旨在添加一个“快速演示”模式，允许用户上传一张或多张图片作为临时的“注册数据库”，然后立刻开启摄像头进行验证。这对于现场演示或测试特定照片非常有用，无需经历完整的注册流程。

## 1. 目标 (Objectives)
- **无需数据库注册**：直接使用上传的图片作为比对源。
- **流程**：上传图片(s) -> 提取特征 -> 开启摄像头 -> 实时验证。
- **页面**：新建 `face_verify_adhoc.html`。

## 2. 详细步骤 (Detailed Steps)

### Step 1: 升级 `FaceMatcher.js`
当前 `FaceMatcher.js` 支持从 Storage 或 JSON 字符串加载数据。为了支持内存中直接加载（Ad-hoc 模式），我们需要添加一个公开方法：
- **新增方法**: `loadFromData(usersArray)`
- **功能**: 直接接受格式为 `[{ id, name, descriptors }]` 的数组并调用内部的 `_processUsers` 进行索引构建。

### Step 2: 创建新页面 `face_verify_adhoc.html`
- **基础结构**: 复制 `face_verify.html` 的头部和样式。
- **UI 布局**:
  - **Zone 1: Reference Images (Target)**
    - 文件上传控件（支持多选 `multiple`）。
    - 预览网格：显示已成功解析的人脸图片缩略图。
    - 状态提示：例如 "Processed 3 images, 1 failed"。
  - **Zone 2: Live Verification**
    - 摄像头预览区域（初始隐藏/禁用）。
    - "Start Verification" 按钮（仅当有有效图片上传后激活）。
- **核心逻辑**:
  1. **图片处理**:
     - 遍历用户上传的每一张图片。
     - 使用 `faceapi.detectSingleFace(img).withFaceLandmarks().withFaceDescriptor()`。
     - 如果检测成功，提取 `descriptor`，并以文件名作为 `name`。
     - 将结果存入临时的 `adhocUsers` 数组。
  2. **初始化匹配器**:
     - 调用 `faceMatcher.loadFromData(adhocUsers)`。
  3. **实时验证**:
     - 开启摄像头，运行标准的检测循环。
     - 使用 `faceMatcher.findBestMatch()` 进行比对。

### Step 3: 修改首页 `home.html`
- 添加新的入口卡片。
- **标题**: "Quick Verification" 或 "Ad-hoc Demo"。
- **图标**: 📸 (Camera) + 🖼️ (Picture)。
- **描述**: "Upload reference photos instantly and verify with webcam. Perfect for quick demos."

## 3. 验证 (Verification)
1. 进入 Quick Demo 页面。
2. 上传 2-3 张不同人的照片（例如：Elon Musk, Iron Man）。
3. 确认系统提示图片处理成功，提取到了特征值。
4. 点击 "Start Verification"。
5. 将摄像头对准其中一张照片（或本人），确认能否正确匹配到对应的文件名。

## 4. 注意事项
- 图片质量：如果上传的图片检测不到人脸，需要给予明确的 UI 提示（例如红色的错误标记）。
- 性能：如果上传图片过多（例如 10+），初始化可能会稍慢，需要 loading indicator。
