# 迁移至 MinerU API 并重构前端设计方案

## 1. 摘要 (Summary)
本计划旨在将后端 OCR 服务从 PaddleOCR 迁移至 MinerU 接口，并应用 `frontend-design` 技能对前端界面进行现代化、工业化风格的重构。最后，将使用 `webapp-testing` 工具对全流程进行自动化测试和验证。

## 2. 当前状态分析 (Current State Analysis)
- **后端 (`backend/server.py`)**: 目前使用 PaddleOCR 的 API 进行图片和 PDF 解析。请求和轮询逻辑是基于 PaddleOCR 的数据结构设计的。
- **前端 (`frontend/app.js` & `index.html` & `style.css`)**: 界面包含“文件/文件夹上传”、“PaddleOCR Token”、“识别”、“分割”、“标记”等步骤。设计风格偏基础和通用，依赖 PaddleOCR 返回的特定 JSON 结构 (`layoutParsingResults`) 来实现图片高亮标记功能。

## 3. 拟议变更 (Proposed Changes)

### 3.1. 后端接口替换为 MinerU
- **文件路径**: `backend/server.py`
- **操作内容**:
  - 移除 PaddleOCR 相关的常量和接口 (`JOB_URL`, `MODEL`, `TOKEN`)。
  - 引入 MinerU 接口配置：`MINERU_API_BASE = "https://mineru.net"` 和对应的 Token 环境变量。
  - 重写 `_submit_job_sync` 和 `_submit_job_bytes_sync`：
    - 第一步：请求 `POST /api/v4/file-urls/batch` 获取上传链接和 `batch_id`。
    - 第二步：通过 `PUT` 将文件直接上传到返回的 `file_url`。
  - 重写 `_poll_job_sync`：
    - 轮询 `GET /api/v4/extract-results/batch/{batch_id}`。
    - 当状态为 `done` 时，提取 `full_zip_url`。
  - 重写结果处理逻辑：
    - 下载并解压 MinerU 返回的 ZIP 文件。
    - 读取压缩包内的 `.md` 文件并合并为最终结果，返回给前端。
    - 移除或精简原先针对 PaddleOCR `jsonl` 的复杂解析逻辑。

### 3.2. 前端设计重构 (应用 frontend-design)
- **文件路径**: `frontend/index.html`, `frontend/style.css`, `frontend/app.js`
- **操作内容**:
  - **视觉风格**: 采用**工业/实用主义 (Industrial/Utilitarian)**或**编辑/排版 (Editorial)**的极致风格。使用高对比度、网格布局、粗犷与精致结合的排版（例如结合独特的大标题字体和清晰的正文字体）。
  - **颜色与主题**: 使用 CSS 变量定义一致的主题，摒弃常见的柔和阴影，使用锐利的边框、纯色色块和清晰的视觉层次。
  - **交互与动画**: 增加 Hover 状态的锐利反馈，任务处理中添加具有机械感或代码感的加载动画。
  - **功能适配**: 
    - 将“PaddleOCR Token”字段更名为“MinerU Token”。
    - 移除“第三步：标记”功能（因其深度依赖 PaddleOCR 特有的返回结构，而 MinerU 返回格式不同）。

### 3.3. 测试与验证 (应用 webapp-testing)
- 使用 `webapp-testing` 编写并执行 Playwright 自动化脚本。
- 启动前后端服务，模拟用户上传测试图片/PDF，填入 Token，点击“识别”按钮。
- 验证任务状态的轮询是否正常，以及最终结果框是否正确回显了 Markdown 内容。

## 4. 假设与决策 (Assumptions & Decisions)
- **Token**: 假设用户将提供有效的 MinerU API Token（从 `https://mineru.net/apiManage/docs` 获取）。若未提供，将使用环境变量中预设的 Token。
- **并发与批量**: 针对文件夹上传，MinerU 的 `/api/v4/file-urls/batch` 支持批量上传。为保持架构简单，第一阶段将在后端对文件夹中的文件进行循环打包或并发请求，最终汇总所有 Markdown。
- **降级功能**: 因接口差异，“标记原始图片中的文字”功能将被移除，以确保核心功能的稳定性和整洁性。

## 5. 验证步骤 (Verification Steps)
1. 运行 `frontend_server.py` 和 `backend/server.py`。
2. 使用 Playwright 打开本地前端地址（如 `http://localhost:8000`）。
3. 检查前端界面的视觉重构是否符合高设计标准。
4. 模拟上传一个简单的 PDF 或图片并触发识别，等待日志输出，检查右侧结果栏是否成功展示 Markdown。