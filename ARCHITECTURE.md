# 架构与代码执行顺序逻辑 (Architecture)

本文档将详细说明 **MinerU2.5pro-PDF** 项目的目录结构、模块划分以及代码在执行时的时序逻辑，以帮助开发者快速理解整个系统的运作机制。

---

## 1. 目录结构
```text
MinerU2.5pro-PDF/
├── backend/
│   ├── requirements.txt  # 后端 Python 依赖库
│   └── server.py         # 核心服务入口，处理 HTTP 路由、MinerU 通信、查重、静态资源等
├── frontend/
│   ├── app.js            # 前端业务逻辑与接口调用
│   ├── index.html        # 前端 UI 主页面
│   └── style.css         # 前端 Apple 风格的样式文件
├── test_dir/             # 自动化测试相关目录 (可忽略)
├── test_app.py           # 自动化测试脚本 (Playwright)
├── README.md             # 项目简介与安装说明
└── ARCHITECTURE.md       # 本文档
```

---

## 2. 核心模块划分

本应用采用了**前后端分离（通过接口通信）但在同一端口混合托管**的架构模式。

### 2.1 前端 (Frontend)
- **`index.html`**：使用原生 HTML 构建极简风格的 DOM 结构，左侧为控制配置面板，右侧为文本结果渲染面板。
- **`style.css`**：基于 CSS Variables (自定义属性) 实现暗/亮模式兼容、平滑过渡动画 (Transition)、高斯模糊背景 (`backdrop-filter`)，构建了 Apple 官网级别的视觉体验。
- **`app.js`**：
  - **DOM 交互**：绑定文件选择、参数读取、按钮状态。
  - **轮询请求**：发起提取请求后，使用定时器 (`setInterval` / 递归 `setTimeout`) 轮询 `/api/status` 以获取后端任务进度。
  - **查重触发**：调用 `/api/check` 将提取出的 Markdown 文本传给后端。

### 2.2 后端 (Backend)
- **静态资源托管**：`server.py` 中的 `Handler` 类继承自 `BaseHTTPRequestHandler`。当路径不以 `/api/` 开头时，解析为请求 `frontend/` 目录下的静态文件。
- **OCR 任务管理**：
  - `/api/ocr/submit`（绝对路径模式） 和 `/api/ocr/upload-folder`（前端上传模式）用来创建异步任务，分配唯一的 `local_job_id`，启动后台线程池 (`concurrent.futures.ThreadPoolExecutor`) 执行真正的调用。
- **MinerU API 通信**：
  - `_submit_job_bytes_sync()`：向 MinerU `/api/v4/file-urls/batch` 申请上传地址 `file_url`，并 `PUT` 上传二进制图片/PDF。
  - `_poll_job_sync()`：定时查询 MinerU `/api/v4/extract-results/batch/{batch_id}`，直至状态变为 `done`，获取 `full_zip_url`。
  - `_process_mineru_zip()`：下载 ZIP，解压出 `images/` 和 `.md`，将相对路径的图片引用替换为本地代理地址，保存至本地硬盘。
- **查重功能 (DivideRepeat)**：
  - `DedupeCore` 类封装了向 Elasticsearch 请求数据的逻辑。
  - `/api/check` 接收 Markdown 文本，分割题目后，通过 `difflib` 计算文本相似度，判断是否达到阈值（如 `0.95`），返回高亮标注后的结果。

---

## 3. 执行顺序逻辑 (Sequence Flow)

下面是用户从发起“开始提取”到完成“智能查重”的完整时序流程：

### 阶段 1：服务启动
1. 用户在终端运行 `python backend/server.py`。
2. 后端读取环境变量并绑定 `8000` 端口。
3. `DedupeCore` 初始化 ES 配置连接。
4. 用户浏览器访问 `http://localhost:8000`，后端路由拦截请求，读取并返回 `frontend/index.html`。

### 阶段 2：提交任务 (提取)
1. **[前端]** 用户选择语言 (如 `zh`)，输入 Token，选择包含图片的文件夹，点击“开始提取”。
2. **[前端]** `app.js` 拦截点击事件，打包表单数据 (包含多张图片二进制流及 `X-Language` 头部)，发送 POST 到 `/api/ocr/upload-folder`。
3. **[后端]** 接收文件并暂存至 `uploadTempDir`。
4. **[后端]** 生成一个唯一的 `local_job_id`，将任务状态记录在全局内存字典 `_jobs` 中（状态为 `pending`），立即向前端返回该 `id`，断开本次 HTTP 连接。
5. **[后端]** 开启异步后台线程，开始执行 MinerU 通信：
   - 遍历暂存文件夹中的每张图片。
   - 调用 `_submit_job_bytes_sync()` 发送到 MinerU 获取 `batch_id`。
   - 调用 `_poll_job_sync()` 阻塞轮询 MinerU 的处理状态，此时全局 `_jobs` 的进度字段随之更新。
   - 任务完成后下载 ZIP 包并解压保存。
6. **[前端]** 收到 `id` 后，每隔 2 秒发起 GET `/api/status?id=xxx` 请求：
   - 如果返回状态是 `polling`/`downloading`/`running`，前端更新状态提示和进度条。
   - 如果返回状态是 `done`，停止轮询，进入阶段 3。

### 阶段 3：结果拉取与渲染
1. **[前端]** 任务 `done` 后，发起 GET `/api/history/assets?id=xxx`。
2. **[后端]** 扫描该任务对应保存在本地 `txt/` 目录下的 `.md` 和 `.txt` 文件，并以 JSON 列表的形式返回。
3. **[前端]** `app.js` 逐一通过返回的文件 URL 获取文件内容，拼接成一整段完整的 Markdown 文本，渲染到右侧的 `<textarea id="output">` 中。

### 阶段 4：智能查重 (DivideRepeat)
1. **[前端]** 文本框有内容后，“开始查重”按钮变为可点击状态。用户点击按钮。
2. **[前端]** 将 `textarea` 中的完整文本序列化为 JSON，POST 到 `/api/check`。
3. **[后端]** 拦截请求，将文本传给 `DedupeCore.check_paper()`：
   - 根据特殊的分割符（如 `############划题标记############` 或默认回车）将文本切分为多题。
   - 对每一题构造 Elasticsearch 的 `multi_match` 查询，向配置的 ES 节点发起请求。
   - 获取 Top-N 结果，通过 `difflib.SequenceMatcher` 计算字符串相似度。
   - 根据阈值 (`0.95`) 判断是否重复，在题目上方插入“是否重复:是/否”标记文本。
4. **[后端]** 将标记好的 Markdown 文本以及成功/失败的统计数据返回给前端。
5. **[前端]** 接收到结果，替换右侧面板中的文本内容，并弹出提示框告知查重统计信息。