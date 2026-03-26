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
