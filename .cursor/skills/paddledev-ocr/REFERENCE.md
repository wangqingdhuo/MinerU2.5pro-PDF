# PaddleDev OCR 参考文档

## PaddleOCR API

**API 端点**: `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs`

**认证**: Bearer Token 认证

**模型**: `PaddleOCR-VL-1.5`

**可选参数**:
```json
{
    "markdownIgnoreLabels": ["header", "footer", "number", "footnote", "aside_text"],
    "useLayoutDetection": true,
    "mergeTables": true,
    "relevelTitles": true,
    "promptLabel": "ocr"
}
```

## Coze 工作流

**API 端点**: `https://api.coze.cn/v1/workflow/run`

**认证**: Bearer Token 认证

**输入格式**: `{subject}\n{text}`

## 图片文件格式

**命名格式**: `p_页面_数字.jpg`

**处理流程**:
1. 获取文件夹下所有图片
2. 按文件名排序
3. 逐个调用 OCR API
4. 保存每张图片的响应到 `res_{原文件名}.txt`
5. 合并所有文本到 `ocr.txt`

## 历史记录数据结构

```json
{
    "id": "folderName/jobId",
    "folderName": "文件夹名",
    "jobId": "任务ID",
    "hasSplit": true,
    "updatedAt": 1234567890
}
```

## res.txt 文件格式

每行一个 JSON 对象，包含 OCR 结果:

```json
{
    "result": {
        "layoutParsingResults": [
            {
                "markdown": {
                    "text": "识别的文本",
                    "images": {"local_path": "remote_url"}
                },
                "prunedResult": {
                    "parsing_res_list": [
                        {
                            "block_content": "识别的文本块",
                            "block_bboxes": [[x1, y1, x2, y2], ...]
                        }
                    ]
                }
            }
        ]
    }
}
```

**重要**: `block_content` 中的换行符可能是真实换行符（ASCII 10），也可能包含字面 `\n`。`fuzzyMatch` 函数会自动规范化处理这两种情况。

## 标记功能原理

1. 加载所有 `res_*.txt` 文件
2. 解析每个文件的 `block_content` 字段
3. 规范化文本：处理真实换行符 `\n` 和字面 `\n`，压缩空白字符
4. 模糊匹配搜索文本（不区分大小写）
5. 提取匹配项的图片名称和边界框
6. 在原图中绘制高亮框

## fuzzyMatch 规范化处理

```javascript
const normalize = (str) => str
    .replace(/\\n/g, '\n')      // 字面 \n 转真实换行
    .replace(/\r\n?/g, '\n')     // Windows/Mac 换行转标准
    .replace(/\s+/g, ' ')        // 压缩空白为单个空格
    .trim();
```

## 代码引用

### 参考答案文件夹检测

```456:462:backend/server.py
def _get_answer_folder(folder_path: str) -> str | None:
    """获取参考答案文件夹路径"""
    for name in ANSWER_FOLDER_NAMES:
        answer_path = os.path.join(folder_path, name)
        if os.path.isdir(answer_path):
            return answer_path
    return None
```

### 参考答案文件夹名称常量

```68:69:backend/server.py
# 参考答案文件夹名称列表
ANSWER_FOLDER_NAMES = ["参考答案", "答案", "answer", "Answer", "ANSWER", "答案解析"]
```

### 参考答案处理流程

```774:844:backend/server.py
    # 处理参考答案文件夹
    answer_folder = _get_answer_folder(folder_path)
    answer_md_parts = []
    answer_txt_parts = []

    if answer_folder:
        has_answer = True
        log_msg = f"找到参考答案文件夹"
        _update_job(local_job_id, {"log": log_msg})

        # 创建参考答案目录结构
        answer_imgs_dir = os.path.join(base_dir, "参考答案", "imgs")
        answer_pdfs_dir = os.path.join(base_dir, "参考答案", "pdfs")
        answer_txt_dir = os.path.join(base_dir, "参考答案", "txt")
        os.makedirs(answer_imgs_dir, exist_ok=True)
        os.makedirs(answer_pdfs_dir, exist_ok=True)
        os.makedirs(answer_txt_dir, exist_ok=True)

        # 复制参考答案图片
        answer_images = _get_all_images_from_folder(answer_folder)
        for img_path in answer_images:
            img_basename = os.path.basename(img_path)
            try:
                dest_path = os.path.join(answer_imgs_dir, img_basename)
                if not os.path.exists(dest_path):
                    with open(img_path, "rb") as src:
                        _write_bytes(dest_path, src.read())
            except Exception:
                pass

        # 复制参考答案PDF
        _copy_pdfs_from_folder(answer_folder, answer_pdfs_dir)

        # 并发处理参考答案图片
        answer_processed = []
        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_OCR) as executor:
            future_to_img = {
                executor.submit(_process_single_image, img_path, os.path.join(base_dir, "参考答案"), folder_name, local_job_id): img_path
                for img_path in answer_images
            }

            for future in as_completed(future_to_img):
                try:
                    result = future.result()
                    if result and result.get("success"):
                        answer_processed.append(result)
                except Exception as e:
                    _update_job(local_job_id, {
                        "log": f"处理参考答案 {os.path.basename(future_to_img[future])} 失败: {str(e)}"
                    })

        # 按参考答案图片原顺序排序
        sorted_answer_images = sorted(answer_images, key=os.path.basename)
        answer_order = {os.path.basename(p): i for i, p in enumerate(sorted_answer_images)}
        answer_processed.sort(key=lambda x: answer_order.get(x["img_basename"], 999))

        # 等待所有参考答案图片处理完成后再合并
        log_msg = f"所有参考答案图片识别完成，共 {len(answer_processed)} 张成功，开始合并..."
        _update_job(local_job_id, {"log": log_msg})

        # 按顺序收集参考答案文本
        for result in answer_processed:
            answer_md_parts.extend(result["markdown_parts"])
            answer_txt_parts.extend(result["txt_parts"])

    # 最后合并：原文 + 参考答案标识 + 参考答案内容
    if has_answer:
        all_txt.append("\n\n=====参考答案=====\n\n")
        all_md.append("\n\n=====参考答案=====\n\n")
        all_txt.extend(answer_txt_parts)
        all_md.extend(answer_md_parts)
```

### 等待所有识别完成的并发处理

```717:772:backend/server.py
    # 使用 ThreadPoolExecutor 并发处理
    processed_results = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_OCR) as executor:
        # 提交所有任务
        future_to_img = {
            executor.submit(_process_single_image, img_path, base_dir, folder_name, local_job_id): img_path
            for img_path in images
        }

        completed = 0
        for future in as_completed(future_to_img):
            completed += 1
            img_path = future_to_img[future]
            img_basename = os.path.basename(img_path)

            try:
                result = future.result()
                if result and result.get("success"):
                    processed_results.append(result)
                else:
                    failed_count += 1
                    error_msg = result.get("error", "未知错误") if result else "任务执行失败"
                    _update_job(local_job_id, {
                        "log": f"处理图片 {img_basename} 失败: {error_msg}"
                    })
            except Exception as e:
                failed_count += 1
                _update_job(local_job_id, {
                    "log": f"处理图片 {img_basename} 失败: {str(e)}"
                })

            # 更新进度
            _update_job(local_job_id, {
                "state": "processing_image",
                "progress": {
                    "completed": completed,
                    "total": total_images,
                    "failed": failed_count
                }
            })

    # 等待所有正文图片处理完成后再合并
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

### hasAnswer 传递给 Coze 工作流

```112:122:backend/server.py
def _coze_run_workflow_sync(user_input: str, subject: str, has_answer: bool) -> str:
    """同步调用 Coze 工作流"""
    if not COZE_WORKFLOW_ID:
        raise RuntimeError("missing COZE_WORKFLOW_ID")
    # 将学科拼接在文本上方
    full_input = f"{subject}\n{user_input}"
    payload = {
        "workflow_id": COZE_WORKFLOW_ID,
        "is_async": True,
        "parameters": {"USER_INPUT": full_input, "hasanswer": has_answer},
    }
```

### 前端轮询识别完成状态

```463:518:frontend/app.js
// 轮询 OCR 任务结果
async function pollResult(jobId) {
  const startedAt = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 1200));
    const status = await getJson(`${API_BASE}/api/ocr/${jobId}`);
    setStatus(status.state || "unknown");

    // 显示提取进度（文件夹模式）
    if (status.state === "processing_image" && status.progress) {
      const completed = status.progress.completed || "?";
      const total = status.progress.total || "?";
      const failed = status.progress.failed || 0;
      $("#meta").textContent = `处理图片 ${completed}/${total}${failed > 0 ? ` (${failed}失败)` : ''}`;
      if (status.log) {
        log(status.log);
      }
    }

    if (status.state === "failed") {
      throw new Error(status.error || "failed");
    }
    if (status.state === "done") {
      const res = status.result || {};
      $("#output").value = res.text || "";
      currentOutputDir = res.outputDir || null;
      currentContentType = "ocr";
      currentHasAnswer = res.hasAnswer || false;
      // ... 后续处理
      return;
    }
  }
}
```
