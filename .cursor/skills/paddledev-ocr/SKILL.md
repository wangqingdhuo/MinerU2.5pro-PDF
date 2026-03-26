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
