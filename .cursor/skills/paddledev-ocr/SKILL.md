---
name: paddledev-ocr
description: 开发 PaddleDev OCR 项目的技能。该项目使用 PaddleOCR API 进行图片文字识别，支持文件夹批量处理、参考答案识别、文本分割和标记功能。用于开发或修改 PaddleDev 项目时。
---

# PaddleDev OCR 项目开发指南

## 项目结构

```
PaddleDev/
├── backend/
│   └── server.py          # 后端服务器 (Python)
├── frontend/
│   ├── index.html         # 前端页面
│   ├── app.js             # 前端逻辑
│   └── style.css          # 样式文件
└── .cursor/skills/        # 项目级技能
```

## 核心功能

1. **文件夹识别**: 输入文件夹路径，识别所有 .jpg/.png 等图片
2. **参考答案处理**: 检测"参考答案"文件夹并合并识别
3. **OCR 识别**: 调用 PaddleOCR API 进行文字识别
4. **文本分割**: 调用 Coze 工作流进行学科分割
5. **标记功能**: 在原图中高亮标记匹配文本

## 后端 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/ocr` | POST | 提交文件夹/文件路径进行 OCR |
| `/api/ocr/{jobId}` | GET | 查询 OCR 任务状态 |
| `/api/coze/run` | POST | 运行文本分割 |
| `/api/history` | GET | 获取历史记录列表 |
| `/api/history/item?id=` | GET | 获取历史任务详情 |
| `/api/history/assets?id=` | GET | 获取任务关联的所有文件 |

## 数据存储

- 输出目录: `D:\paddlelog`
- 目录结构: `{folderName}/{jobId}/`
- 关键文件:
  - `ocr.txt` - 合并的识别文本
  - `split.txt` - 分割后的文本
  - `res_{图片名}.txt` - 每张图片的 API 响应
  - `res_answer_{图片名}.txt` - 参考答案图片的响应

## 关键参数

### hasAnswer 参数
- 在文件夹中发现参考答案文件夹时设置为 `true`
- 传递到分割 API 用于 Coze 工作流处理
- 返回历史记录时会检测 `res_answer_*.txt` 文件

### 参考答案文件夹名称
```python
["参考答案", "答案", "answer", "Answer", "ANSWER", "答案解析"]
```

## 有参考答案试卷的分割流程

### 1. 参考答案文件夹检测

当用户上传文件夹后，后端会检测是否存在参考答案子文件夹：

```python
# 参考答案文件夹检测函数
def _get_answer_folder(folder_path: str) -> str | None:
    for name in ANSWER_FOLDER_NAMES:  # ["参考答案", "答案", "answer", ...]
        answer_path = os.path.join(folder_path, name)
        if os.path.isdir(answer_path):
            return answer_path
    return None
```

### 2. 参考答案图片处理流程

在 `_process_folder_sync` 函数中，参考答案的处理流程如下：

```
1. 识别正文图片 → 收集 markdown_parts, txt_parts
2. 检测参考答案文件夹是否存在
3. 如果存在：
   a. 创建参考答案目录结构: base_dir/参考答案/imgs, pdfs, txt
   b. 复制参考答案图片到参考答案/imgs/
   c. 并发 OCR 识别参考答案图片
   d. 按文件名排序保持顺序
   e. 收集参考答案的 markdown_parts, txt_parts
4. 最后合并：正文 + "=====参考答案=====" + 参考答案
```

**关键代码位置** (`server.py` 第 774-844 行):

```python
# 处理参考答案文件夹
answer_folder = _get_answer_folder(folder_path)
answer_md_parts = []
answer_txt_parts = []

if answer_folder:
    has_answer = True
    # 创建参考答案目录结构
    answer_imgs_dir = os.path.join(base_dir, "参考答案", "imgs")
    os.makedirs(answer_imgs_dir, exist_ok=True)
    
    # 复制参考答案图片
    answer_images = _get_all_images_from_folder(answer_folder)
    for img_path in answer_images:
        # 复制到参考答案/imgs/
        ...
    
    # 并发处理参考答案图片
    answer_processed = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_OCR) as executor:
        future_to_img = {
            executor.submit(_process_single_image, img_path, ...): img_path
            for img_path in answer_images
        }
        # 等待所有参考答案图片完成
        for future in as_completed(future_to_img):
            result = future.result()
            if result.get("success"):
                answer_processed.append(result)
    
    # 按原顺序排序
    sorted_answer_images = sorted(answer_images, key=os.path.basename)
    answer_order = {os.path.basename(p): i for i, p in enumerate(sorted_answer_images)}
    answer_processed.sort(key=lambda x: answer_order.get(x["img_basename"], 999))
    
    # 收集参考答案文本
    for result in answer_processed:
        answer_md_parts.extend(result["markdown_parts"])
        answer_txt_parts.extend(result["txt_parts"])

# 最后合并：正文 + 参考答案标识 + 参考答案内容
if has_answer:
    all_txt.append("\n\n=====参考答案=====\n\n")
    all_md.append("\n\n=====参考答案=====\n\n")
    all_txt.extend(answer_txt_parts)
    all_md.extend(answer_md_parts)
```

### 3. hasAnswer 标记传递

- OCR 完成时，`has_answer` 标志存入 `meta.json`
- 分割请求时，`hasAnswer` 传递给 Coze 工作流
- Coze 工作流根据 `hasanswer` 参数决定分割策略

```python
# 创建 Coze 任务时传递 hasAnswer
payload = {
    "workflow_id": COZE_WORKFLOW_ID,
    "is_async": True,
    "parameters": {"USER_INPUT": full_input, "hasanswer": has_answer},
}
```

## 识别完成判断与文本合并机制

### 1. 识别完成的判断逻辑

**文件夹模式**使用 `ThreadPoolExecutor` + `as_completed` 确保所有图片识别完成后才合并：

```python
# 关键代码位置 (server.py 第 717-756 行)

# 使用 ThreadPoolExecutor 并发处理
processed_results = []
with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_OCR) as executor:
    # 提交所有任务
    future_to_img = {
        executor.submit(_process_single_image, img_path, ...): img_path
        for img_path in images
    }
    
    # 等待所有任务完成（关键！）
    for future in as_completed(future_to_img):
        completed += 1
        result = future.result()  # 阻塞等待此任务完成
        
        if result and result.get("success"):
            processed_results.append(result)
        else:
            failed_count += 1
        
        # 更新进度
        _update_job(local_job_id, {
            "progress": {"completed": completed, "total": total_images, "failed": failed_count}
        })

# 所有正文图片识别完成后才执行这里
log_msg = f"所有正文图片识别完成，共 {len(processed_results)} 张成功，开始合并文本..."
_update_job(local_job_id, {"log": log_msg})

# 按原图片顺序排序结果
sorted_images = sorted(images, key=os.path.basename)
image_order = {os.path.basename(p): i for i, p in enumerate(sorted_images)}
processed_results.sort(key=lambda x: image_order.get(x["img_basename"], 999))

# 组装正文文本（按顺序）
for result in processed_results:
    all_md.extend(result["markdown_parts"])
    all_txt.extend(result["txt_parts"])
    total_pages += result["pages"]
```

### 2. 为什么必须等待所有图片识别完成

1. **顺序保证**: 试卷题目需要按顺序排列，不能乱序
2. **参考答案位置**: 参考答案必须跟在正文之后
3. **文本连续性**: 合并后的文本需要连贯

### 3. 参考答案识别的等待机制

```python
# 参考答案处理同样使用 as_completed 等待
answer_processed = []
with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_OCR) as executor:
    future_to_img = {
        executor.submit(_process_single_image, img_path, ...): img_path
        for img_path in answer_images
    }
    
    # 等待所有参考答案图片完成
    for future in as_completed(future_to_img):
        result = future.result()
        if result and result.get("success"):
            answer_processed.append(result)

# 确保参考答案全部完成后再合并
log_msg = f"所有参考答案图片识别完成，共 {len(answer_processed)} 张成功，开始合并..."
_update_job(local_job_id, {"log": log_msg})
```

### 4. 合并完成的标志

```python
# 最终合并并保存
merged_md = "\n\n".join(all_md)
merged_txt = "\n\n".join(all_txt)
_write_text(os.path.join(base_dir, "ocr.md"), merged_md)
_write_text(os.path.join(base_dir, "ocr.txt"), merged_txt)

# 保存元数据
meta_data = {
    "hasAnswer": has_answer,
    "pages": total_pages,
    "failedCount": failed_count,
    "finishedAt": _now_ms(),
}
_write_text(meta_file, json.dumps(meta_data))

# 更新任务状态为 done
_update_job(local_job_id, {"state": "done", "result": {...}})
```

### 5. 前端轮询完成状态

```javascript
// 前端 pollResult 函数 (app.js 第 463-518 行)
async function pollResult(jobId) {
    while (true) {
        await new Promise((r) => setTimeout(r, 1200));
        const status = await getJson(`${API_BASE}/api/ocr/${jobId}`);
        
        // 显示进度
        if (status.state === "processing_image" && status.progress) {
            const completed = status.progress.completed;
            const total = status.progress.total;
            $("#meta").textContent = `处理图片 ${completed}/${total}`;
        }
        
        // 识别完成
        if (status.state === "done") {
            const res = status.result || {};
            $("#output").value = res.text || "";  // 合并后的完整文本
            currentHasAnswer = res.hasAnswer || false;
            return;
        }
    }
}
```

## 前端状态变量

```javascript
currentOutputDir     // 当前任务输出目录
currentContentType   // "ocr" 或 "split"
currentHasAnswer     // 是否有参考答案
cachedResData        // 缓存的 res 数据
```

## 开发注意事项

1. **保持局域网访问**: 使用 `window.location.hostname` 获取 API 地址
2. **多图片处理**: 每张图片独立调用 OCR，独立保存 res 文件
3. **参考答案标识**: 原文和参考答案之间添加 `=====参考答案=====`
4. **标记搜索**: 从多个 `res_*.txt` 文件中搜索匹配文本
5. **换行符处理**: `block_content` 可能包含真实换行符 `\n` 或字面 `\n`，`fuzzyMatch` 会自动规范化
6. **匹配逻辑**: 搜索时不区分大小写，多余空白会被压缩匹配
7. **PDF合并缓存**: OCR完成后自动在后台生成合并PDF，`_ensure_merged_pdf` 会检查是否已存在避免重复生成
8. **图片顺序**: 使用 `sorted(os.listdir(imgs_dir))` 按文件名排序保持顺序
