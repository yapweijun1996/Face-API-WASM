# Face TMS — 人脸考勤系统示例

一个**纯前端、可离线**的人脸打卡考勤系统（Time Management System），演示
[Face-API-WASM](../../README.md) 在真实场景里能做什么：员工注册人脸 → 走到镜头前
自动识别 → 一键上/下班打卡 → 查看考勤记录与工时 → 导出 CSV。

没有后端、没有服务器、没有网络请求——人脸特征和打卡记录全部留在用户**本机浏览器**里。

> **在线 Demo**：<https://yapweijun1996.github.io/Face-API-WASM/examples/TMS/>

---

## 功能

| 标签 | 能力 |
|------|------|
| **打卡** | 实时摄像头 1:N 人脸识别，认出员工后显示姓名 + 置信度，按上次状态自动给出「上班 / 下班」按钮，一键打卡。60 秒冷却防止连续误触发。 |
| **员工** | 输入姓名/部门 → 采集 12 帧人脸完成注册（自动留存一张脸部照片）；列表/打卡卡片显示头像照片；删除员工。 |
| **记录** | 考勤流水表、当日工时自动配对统计（in/out 配对求时长）、导出 CSV、可调识别灵敏度。 |

## 技术要点

- **IndexedDB** (`TMS_DB`)：员工人脸特征（128 维 descriptor）+ 打卡流水，结构化、可增长。
- **localStorage** (`tms_settings`)：匹配阈值、打卡冷却、采集帧数等轻量偏好。
- **PWA**：可「添加到主屏幕」独立运行，离线可用。
  - **应用代码** (`index.html` / `tms-*.js`) 走 **network-first**：在线时永远拿服务器最新版本。
  - **模型 / 库**（约 12MB，几乎不变）走 **cache-first**：首次下载后秒开、可离线。
  - 升级时把 [`sw.js`](sw.js) 里的 `VERSION` 加一 → 页面顶部弹「立即更新」→ 点击后
    `skipWaiting` + 自动 `reload`，**强制运行最新代码**（不会在打卡途中突然刷新）。
- **响应式**：手机/iPad 用底部 Tab 导航 + 单列；≥820px（iPad 横屏 / 桌面）切换为顶部
  Tab + 打卡页两栏布局。`viewport-fit=cover` + `safe-area-inset` 适配刘海屏。
- **复用核心模块**：注册用 `FaceRegistrationManager`，识别用 `FaceMatcher`，
  检测器用 `TinyFaceDetector`（移动端更快）。
- **i18n**：英文 / 简体中文，右上角一键切换，默认跟随浏览器语言（[`js/tms-i18n.js`](js/tms-i18n.js)）。

## 运行

必须用 **HTTPS 或 `localhost`**（浏览器要求安全上下文才能开摄像头 + 注册 Service Worker）。

```bash
# 在仓库根目录
python3 -m http.server 8000
# 打开 http://localhost:8000/examples/TMS/
```

或直接访问上面的在线 Demo。

## 文件结构

```
examples/TMS/
├── index.html              # 单页应用（UI + 响应式样式 + PWA meta）
├── manifest.webmanifest    # PWA 清单
├── sw.js                   # Service Worker（network-first 代码 / cache-first 资源）
├── icon.svg                # 应用图标
├── js/
│   ├── tms-db.js           # IndexedDB（员工/考勤）+ localStorage（设置）
│   └── tms-app.js          # 主逻辑：初始化、摄像头、识别、注册、UI、PWA 更新
└── README.md
```

依赖仓库根目录已有的 `js/lib/`（tf + face-api）、`js/core/`（FaceRegistrationManager、
FaceMatcher）与 `models/`，通过相对路径 `../../` 引用，无需复制。

## 隐私

所有人脸特征与打卡数据只存于浏览器本地（IndexedDB / localStorage），不上传任何服务器。
清除浏览器数据即可彻底删除。
