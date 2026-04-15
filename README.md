# MinerU 文档提取专业版 (MinerU2.5pro-PDF)

基于 MinerU API 构建的现代化、极简风格的文档（PDF/图片）OCR 提取工具。本项目将复杂的 OCR 提取与智能题库查重功能整合于一身，并采用了 Apple 官网级别的流畅前端交互设计。

## ✨ 核心特性

- **🚀 MinerU 强力驱动**：抛弃了传统的本地识别方案，通过调用 [MinerU API](https://mineru.net/apiManage/docs) 进行高质量的 PDF 和图片识别提取。
- **🌐 多语言精准提取**：支持中文（默认）、英文、日文、法/德/西语、俄语、西里尔字母以及自动检测等多种语系配置，显著提升识别率。
- **🍏 Apple 级极简美学**：使用大面积留白、无衬线字体（`SF Pro` 等）、高斯模糊（Glassmorphism）、微投影与顺滑过渡动画，打造极致清爽的 Web 界面。
- **🔍 智能查重 (DivideRepeat)**：原生集成 [DivideRepeat](https://github.com/wangqingdhuo/DivideRepeat) 的核心查重逻辑，提取文本后可直接与本地 Elasticsearch 题库进行重复性校验。
- **📦 一键单端部署**：前后端合一架构。只需运行一个 Python 脚本即可启动所有服务，静态页面由 Python HTTP 服务器直接提供（运行在 `8000` 端口）。

---

## 🛠️ 安装与部署

### 1. 环境要求
- **Python 3.8+**
- (可选) **Elasticsearch** (如需使用查重功能，请确保服务已启动并建立好索引)

### 2. 克隆项目并安装依赖
```bash
git clone https://github.com/wangqingdhuo/MinerU2.5pro-PDF.git
cd MinerU2.5pro-PDF

# 安装后端所需的依赖（如 requests 等）
pip install -r backend/requirements.txt
```

### 3. 启动服务
只需运行后端的入口文件，即可同时启动 API 服务与静态网页托管：
```bash
python backend/server.py
```
> 服务默认将在 `http://0.0.0.0:8000` 启动。

### 4. 环境变量 (可选配置)
您可以直接在前端页面中输入 Token，也可以通过环境变量全局设置：
- `MINERU_TOKEN`：MinerU 的 API 凭证。
- `ES_URL`：Elasticsearch 地址 (默认：`http://192.168.157.128:9200`)。
- `ES_INDEX`：Elasticsearch 题库索引名 (默认：`questions`)。
- `PORT`：Web 服务端口 (默认：`8000`)。

---

## 📖 使用指南

1. **访问界面**：在浏览器中打开 [http://localhost:8000](http://localhost:8000)。
2. **选择文件/目录**：
   - 方式一：在文本框中输入服务端所在的绝对目录路径。
   - 方式二：点击“选择文件夹”，直接从浏览器本地上传图片/PDF文件。
3. **配置参数**：
   - 输入你的 **MinerU API Token**（若已配置环境变量则可留空）。
   - 在下拉框中选择要识别的**文档语言**以提高提取准确度。
4. **开始提取**：点击“开始提取”，右侧面板将实时展示 MinerU 返回的 Markdown 格式文本。
5. **查重**：若后台配置了 ES 服务，可直接点击“开始查重”进行题库重复率校验，结果将高亮标注于文本中。

---

## 🤝 贡献与支持
如果您在使用中遇到问题，或者有更好的想法与建议，欢迎提交 Issue 或 Pull Request！