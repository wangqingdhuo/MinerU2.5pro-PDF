# PaddleDev

一套轻量的 OCR 前后端示例，提供“识别 → 分割 → 预览 → 历史”的完整流程。前端基于原生 HTML/CSS/JS，无依赖构建工具；后端使用 Python 标准库 `http.server` 搭建，默认监听 `8099` 端口。

## 功能特性

- 识别
  - 支持上传 PDF/图片 或 服务器本地路径发起识别。
  - 识别完成后在右侧文本框展示结果（即 `ocr.txt` 内容）。
  - 自动记录页数与耗时元信息。
  - 自动保存原始 PDF/图片到该任务目录，便于归档与对比。

- 分割
  - 选择学科后对识别文本进行二次分割。
  - 分割完成后结果会覆盖右侧文本框，同时写入 `split.txt`，与 `ocr.txt` 同目录保存。
  - 历史记录支持查看分割结果。

- 预览
  - 点击“预览”弹出新窗口：
    - 左侧：显示该任务目录中的原始 PDF 或图片（优先展示 PDF）。
    - 右侧：展示解析后的内容；支持 HTML 标签、图片展示与 LaTeX（KaTeX）公式解析。
  - KaTeX 加载支持“本地优先 + CDN 回退”的多源自动切换，在局域网环境也能解析公式。
  - 保留文本框中的换行格式（`white-space: pre-wrap`）。

- 历史记录
  - 弹出历史列表，列出已存在 `ocr.txt` 的任务；若存在 `split.txt` 会展示“查看分割结果”按钮。
  - 点击可加载对应历史（识别/分割）文本到右侧文本框，继续预览与拷贝。

## 目录结构（运行产物）

```
D:\paddlelog\<folderName>\<jobId>\
├── 原始文件.pdf / 原始图片.png/...   # 识别时保存的原始文件（上传或本地路径复制）
├── output\
│   └── imgs\                        # 识别中下载并保存的图片块
│       └── *.jpg
├── ocr.txt                          # 识别合并文本（页面右侧默认展示内容）
├── ocr.md                           # 识别合并 Markdown（图片路径相对 output/imgs，可本地直接预览）
├── split.txt                        # 分割后的文本（存在时历史列表可查看）
└── <baseName>_0.md / <baseName>_0.txt ...  # 分页文本
```

> 注意：前端预览里对图片路径做了统一转换，通过后端静态路由 `/output/…` 提供图片；`.md` 文件内保留相对路径 `output/imgs/...`，本地 Markdown 查看器可直接显示。

## 前端使用

- 打开前端页面：[frontend/index.html](file:///c:/Users/XWZJ93/Desktop/%E5%8E%9F%E7%94%B5%E8%84%91/PycharmProjects/PycharmProjects/AiTest/PaddleDev/frontend/index.html)
- 选择“文件路径”或“选择文件”，点击“识别”。
- 右侧文本框显示识别结果，点击“预览”可对比原始与解析结果。
- 第二步“分割文本”：选择学科后提交，完成后可在历史查看 `split.txt`。

预览窗口（右侧）解析能力由 KaTeX 与浏览器渲染提供，KaTeX 资源加载多源：

- 本地：`frontend/vendor/katex/*`
- CDN：jsDelivr、unpkg、cdnjs（自动回退）

## 后端启动

后端文件： [backend/server.py](file:///c:/Users/XWZJ93/Desktop/%E5%8E%9F%E7%94%B5%E8%84%91/PycharmProjects/PycharmProjects/AiTest/PaddleDev/backend/server.py)

```
py backend/server.py
# 输出：API listening on http://0.0.0.0:8099
```

默认端口：`8099`  
默认输出根目录：`D:\paddlelog`（可通过环境变量 `PADDLE_LOG_DIR` 覆盖）

### 主要接口

- `POST /api/ocr`  
  发起识别（本地路径）。Body: `{"path": "D:/path/to/file.pdf"}`  
  返回：`{"jobId": "..."}`

- `POST /api/ocr/upload`  
  发起识别（上传）。`multipart/form-data` 字段名：`file`

- `GET /api/ocr/{jobId}`  
  轮询任务状态，完成后返回：
  ```json
  {
    "result": {
      "text": "识别合并文本",
      "pages": 12,
      "outputDir": "D:/paddlelog/<folder>/<jobId>"
    }
  }
  ```

- `POST /api/coze/run`  
  分割文本。Body: `{"subject":"学科","text":"要分割的文本","outputDir":"任务目录（可选）"}`  
  若传入 `outputDir`，分割完成会写入 `split.txt`。

- 历史相关：
  - `GET /api/history?limit=200` → 返回历史任务列表（含 `hasSplit` 字段）。
  - `GET /api/history/item?id=<folder/jobId>[&type=split]` → 返回对应 `ocr.txt` 或 `split.txt` 内容。
  - `GET /output/...` → 静态文件服务（图片/PDF 等），用于预览。

## 预览逻辑说明

- 右侧解析内容：
  - 支持 HTML 标签与图片展示；图片路径自动重写为后端的 `/output/...` 路由。
  - LaTeX 公式解析：支持 `$$...$$`、`\[...\]`、`$...$`、`\(...\)`，`strict: "ignore"` 以兼容中文等字符。
  - 保留换行：`white-space: pre-wrap`。

- 左侧原始文件：
  - 优先显示 PDF（`iframe 100%`），否则显示第一张图片。
  - 两侧各自滚动，布局 50% / 50%，方便对比。

## 开发说明

- 代码入口
  - 前端主脚本：[frontend/app.js](file:///c:/Users/XWZJ93/Desktop/%E5%8E%9F%E7%94%B5%E8%84%91/PycharmProjects/PycharmProjects/AiTest/PaddleDev/frontend/app.js)
  - 后端服务：[backend/server.py](file:///c:/Users/XWZJ93/Desktop/%E5%8E%9F%E7%94%B5%E8%84%91/PycharmProjects/PycharmProjects/AiTest/PaddleDev/backend/server.py)

- 行尾与编码
  - 建议在仓库加 `.gitattributes` 统一行为 LF（可按需添加）。
  - 本项目多为 UTF-8 编码。

## 常见问题

1. 预览页公式不渲染？  
   - 局域网/外网访问受限时，KaTeX CDN 加载可能失败；预览页会回退到本地 `vendor/katex` 资源。仍失败时，检查浏览器控制台与网络权限。

2. 图片不显示？  
   - 确认 `D:\paddlelog` 下对应任务目录是否存在图片；
   - 确认后端 `/output/...` 路由是否可访问；
   - 页内图片路径由前端自动转换，请确保任务目录结构未被改动。

3. 历史列表没有记录？  
   - 仅在存在 `ocr.txt` 的任务目录才会显示；先完成一次识别。

## 许可证

本项目仅用于演示与内部使用，若需开源协议可在此处补充（例如 MIT / Apache-2.0）。

