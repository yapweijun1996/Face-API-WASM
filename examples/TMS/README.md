# Face TMS — 人脸考勤系统示例

一个**纯前端、可离线**的人脸打卡考勤系统（Time Management System），演示
[Face-API-WASM](../../README.md) 在真实场景里能做什么：员工注册人脸 → 走到镜头前
自动识别 → 一键上/下班打卡 → 查看考勤记录与工时 → 导出 CSV。

没有后端、没有服务器、没有网络请求——人脸特征和打卡记录全部留在用户**本机浏览器**里。

> **在线 Demo**：<https://yapweijun1996.github.io/Face-API-WASM/examples/TMS/>

## 演示

> 多人同时打卡演示 GIF（占位）：录屏后导出为 `examples/TMS/docs/multi-clock.gif`，
> 再把下面这行取消注释即可在 README 顶部展示。
>
> <!-- ![多人同时打卡](docs/multi-clock.gif) -->

---

## 功能

| 标签 | 能力 |
|------|------|
| **打卡** | 实时摄像头 **多人同时**识别（detectAllFaces）。用 **IoU 人脸追踪**把每帧人脸框关联到稳定 track，**按位置**（而非按员工 id）维护各自的倒计时 / 本地挑战 / 自动打卡——同一员工被两张脸（本人 + 墙上照片 / 双胞胎）同时拍到也互不串状态，且经冷却去重只写一次。识别到员工后**对准保持 ~1.5 秒自动打卡**，无需按钮；成功后从该人脸位置**迸发庆祝粒子** + **语音问候** + 提示音。**AI 视觉活体核验（可选，默认关闭）**= 抓约 5 帧发给本机 LM Studio 的 MiniCPM-V，由大模型判「真人 vs 照片/屏幕/视频」；非认证级 PAD（详见亮点能力）。60 秒冷却防误触。 |
| **看板** | 实时仪表盘：当前在岗人数、今日迟到数、员工总数；「当前在岗」列表（头像 + 上班时间）；近 7 天工时柱状图。 |
| **员工** | 输入姓名/部门 → 采集 12 帧人脸完成注册（自动留存一张脸部照片）；列表/打卡/看板显示头像照片；删除员工。 |
| **记录** | 考勤流水表 + **状态徽章**（迟到/早退/加班/正常）、当日工时统计、导出 CSV。 |

排班规则在「记录」标签下配置（上班/下班时间、迟到宽限）；打卡时按规则自动判定迟到 / 早退 / 加班。

## 亮点能力

- 👥 **多人同时打卡**：一次识别画面里所有人脸，**按位置追踪**每个人独立倒计时/活体/打卡，适合上班高峰排队。
- 🎯 **人脸位置追踪（IoU）**：状态绑定到物理人脸位置而非员工 id，双胞胎 / 本人+照片不再共享倒计时。
- 🎉 **打卡成功粒子庆祝**：从人脸位置迸发彩色粒子（上班绿、下班红）。
- 🎥 **实时画面标签 + 自动打卡**：姓名/倒计时环直接叠加在视频上，对准即打卡，免按钮。
- 🛡 **AI 视觉活体核验（可选，默认关闭）**：打卡时抓约 5 帧整帧（1fps×5）发给**本机 LM Studio** 的 **MiniCPM-V** 视觉模型，由大模型判「真人在场 vs 伪造（照片/手机或屏幕/打印件/面具）」。看的是**整帧上下文**——能识破「举着手机播视频」（手、屏幕边框、人脸只占小矩形），这正是小型纹理模型挡不住的。人脸框上方实时显示 `live 0.xx` 置信度。画面只发往 localhost,不出网。
  - ⚙️ **前置条件**:本机装 [LM Studio](https://lmstudio.ai/),加载一个视觉模型(如 `minicpm-v-4.6`),开启本地服务器并记下端口;在设置页填 `LM Studio API 地址`(如 `http://127.0.0.1:6501/v1`)与`视觉模型 id`。**LM Studio 不可达时打卡继续但跳过核验(失败放行)**。
  - ⚠️ **诚实边界**:VLM 判别比小模型强,但**仍非认证级 PAD**,也无法保证挡住高水平实时 Deepfake;每次核验约需数秒(采集 5s + 推理 ~5-10s)。请用你自己的真人/照片/屏幕样本验证后再调「真人置信度阈值」(默认 0.5)。高安全场景请接入通过 ISO/IEC 30107-3 PAD 测试的服务端方案。
- 🔊 **语音 + 提示音**：WebAudio 提示音 + SpeechSynthesis 语音问候，随语言切换。
- 📈 **实时看板**：在岗/迟到/工时一目了然。
- 🗓 **排班判定**：迟到 / 早退 / 加班自动标记。

## 技术要点

- **IndexedDB** (`TMS_DB`)：员工人脸特征（128 维 descriptor）+ 打卡流水，结构化、可增长。
- **localStorage** (`tms_settings`)：匹配阈值、打卡冷却、采集帧数等轻量偏好。
- **PWA**：可「添加到主屏幕」独立运行，离线可用。
  - **应用代码** (`index.html` / `tms-*.js`) 走 **network-first**：在线时永远拿服务器最新版本。
  - **模型 / 库**（约 12MB，几乎不变）走 **cache-first**：首次下载后秒开、可离线。（AI 活体核验走本机 LM Studio，无额外前端资产。）
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
│   ├── tms-i18n.js         # 轻量 i18n（英文 / 简体中文，默认英文）
│   ├── tms-tracker.js      # 人脸位置追踪（IoU 关联，按位置维护 hold/活体状态）
│   ├── tms-liveness.js     # AI 视觉活体客户端：MiniCPM-V via LM Studio（提示词/解析纯逻辑可 Node 单测）
│   ├── tms-liveness.test.js# 纯逻辑单测（node --test js/tms-liveness.test.js）
│   └── tms-app.js          # 主逻辑：初始化、摄像头、识别、注册、UI、PWA 更新
└── README.md
```

依赖仓库根目录已有的 `js/lib/`（tf + face-api）、`js/core/`（FaceRegistrationManager、
FaceMatcher）与 `models/`，通过相对路径 `../../` 引用，无需复制。

### 活体核验自测

```bash
node --test examples/TMS/js/tms-liveness.test.js   # 9 项纯逻辑测试（提示词消息体构造 + verdict 解析稳健性）
```

VLM 客户端的端到端推理（连本机 LM Studio、5 帧 → MiniCPM-V → 解析 JSON 判定）与
浏览器跨源调用（CORS）已用 Node + Chrome DevTools 烟测验证；防伪**实际命中率**需在
真实摄像头 + 照片/屏幕样本上校准「真人置信度阈值」。

## 隐私

所有人脸特征与打卡数据只存于浏览器本地（IndexedDB / localStorage），不上传任何服务器。
清除浏览器数据即可彻底删除。
