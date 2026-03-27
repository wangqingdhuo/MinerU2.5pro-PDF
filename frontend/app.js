window.onerror = function(msg, url, line, col, error) {
  log(`Error: ${msg} at ${line}:${col}`);
};

// 后端 API 地址配置
const API_HOST = window.location.hostname || "127.0.0.1";
const API_BASE = `http://${API_HOST}:8099`;

// DOM 操作简写工具
const $ = (s) => document.querySelector(s);
// 日志输出工具
const log = (m) => {
  const el = $("#log");
  el.textContent += m + "\n";
  el.scrollTop = el.scrollHeight;
};
// 设置当前状态显示
const setStatus = (s) => ($("#status").textContent = s);

// 全局状态变量
let katexLoadPromise = null;
let currentOutputDir = null; // 当前任务的输出目录（用于分割任务）
let currentContentType = "ocr"; // 当前显示的内容类型（ocr 或 split）
let currentHasAnswer = false; // 当前任务是否有参考答案

// 运行状态守卫，防止重复提交
const runGuard = {
  running: false,
  ocrDone: false,
  splitDone: false,
  splitting: false,
};

// 更新“识别”按钮的启用状态
function updateRunEnabled() {
  const runEl = $("#run");
  if (!runEl) return;
  const pathEl = $("#path");
  const hasInput =
    !!selectedFile || !!(pathEl && (pathEl.value || "").trim());
  runEl.disabled = runGuard.running || runGuard.splitting || !hasInput;
}

// 动态加载 CSS
function loadCss(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error("css load failed"));
    document.head.appendChild(link);
  });
}

// 动态加载 JS 脚本
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("script load failed"));
    document.head.appendChild(s);
  });
}

// KaTeX 资源 CDN 列表（备选方案）
const sources = [
  {
    name: "local",
    css: "./vendor/katex/katex.min.css",
    js: "./vendor/katex/katex.min.js",
    render: "./vendor/katex/auto-render.min.js",
  },
  {
    name: "jsdelivr",
    css: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
    js: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
    render:
      "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js",
  },
  {
    name: "unpkg",
    css: "https://unpkg.com/katex@0.16.11/dist/katex.min.css",
    js: "https://unpkg.com/katex@0.16.11/dist/katex.min.js",
    render: "https://unpkg.com/katex@0.16.11/dist/contrib/auto-render.min.js",
  },
  {
    name: "cdnjs",
    css: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css",
    js: "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js",
    render:
      "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/contrib/auto-render.min.js",
  },
];

// 确保 KaTeX 已加载，带有失败重试逻辑
async function ensureKatex() {
  if (typeof window.renderMathInElement === "function") return true;
  if (katexLoadPromise) return katexLoadPromise;

  katexLoadPromise = (async () => {
    for (const s of sources) {
      try {
        await loadCss(s.css);
        await loadScript(s.js);
        await loadScript(s.render);
        if (typeof window.renderMathInElement === "function") return true;
      } catch (e) {
        continue;
      }
    }
    return false;
  })();

  return katexLoadPromise;
}

// 更新“分割文本”按钮的启用状态
function updateSplitEnabled() {
  const subjectEl = $("#subject");
  const splitEl = $("#split");
  const outEl = $("#output");
  if (!subjectEl || !splitEl || !outEl) return;
  const subject = (subjectEl.value || "").trim();
  const text = (outEl.value || "").trim();
  splitEl.disabled = !(subject && text);
}

// 更新“预览”按钮的启用状态
function updatePreviewEnabled() {
  const previewEl = $("#preview");
  const outEl = $("#output");
  if (!previewEl || !outEl) return;
  previewEl.disabled = !(outEl.value || "").trim();
}

// 打开预览窗口，处理 Markdown 渲染和公式
function openPreviewWindow() {
  try {
    const content = $("#output").value || "";
    console.log("Opening preview for content length:", content.length);
    
    const previewWin = window.open("", "_blank");
    if (!previewWin) {
      alert("弹出窗口被拦截，请允许弹出窗口。");
      return;
    }

    // 处理内容：将本地图片路径替换为后端可访问的 URL
    const processedContent = content.replace(/src="([^"]+)"/g, (match, p1) => {
      // 跳过远程 URL
      if (p1.startsWith("http")) return match;
      
      // 提取相对于 OUTPUT_ROOT 的路径
      const relativePart = p1.split("/paddlelog/").pop();
      
      // 构造最终的后端服务 URL
    return `src="${API_BASE}/output/${relativePart}"`;
  });

  // 计算当前任务的 ID 路径，用于加载原始文件（PDF/图片）
  let jobIdPath = null;
  if (currentOutputDir) {
    const rel = String(currentOutputDir).replace(/\\/g, "/");
    const idx = rel.toLowerCase().indexOf("/paddlelog/");
    if (idx >= 0) {
      const tail = rel.slice(idx + "/paddlelog/".length);
      const segs = tail.split("/").filter(Boolean);
      if (segs.length >= 2) jobIdPath = `${segs[0]}/${segs[1]}`;
    } else {
      const segs = rel.split("/").filter(Boolean);
      if (segs.length >= 2) {
        const last = segs[segs.length - 1];
        const prev = segs[segs.length - 2];
        jobIdPath = `${prev}/${last}`;
      }
    }
  }

  // 将内容和数据传递给新窗口
  previewWin.previewData = processedContent;
  previewWin.sourcesData = sources; // 传递所有可用的 KaTeX 来源

  // 构造预览页面的 HTML
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>预览结果 - PaddleDev</title>
  <style>
    html,body{height:100%}
    body{
      margin:0;height:100vh;width:100vw;background:#fff;color:#111;
      font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.6
    }
    .splitRoot{display:grid;grid-template-columns:1fr 1fr;height:100vh;width:100vw}
    .pane{overflow:auto;padding:16px;box-sizing:border-box;border-left:1px solid #eee}
    .pane:first-child{border-left:none}
    .contentWrap{white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;min-height:100%}
    #originalPane img{
      width:100%;
      height:auto;
      display:block;
      margin:12px auto;
      border-radius:4px;
      box-shadow:0 2px 8px rgba(0,0,0,0.08);
    }
    .contentWrap img{
      width:50%;
      height:auto;
      display:block;
      margin:12px auto;
      border-radius:4px;
      box-shadow:0 2px 8px rgba(0,0,0,0.08);
    }
    /* KaTeX 样式微调，防止重叠 */
    .katex-display {
      overflow-x: auto;
      overflow-y: hidden;
      padding: 10px 0;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    th { background-color: #f2f2f2; }
    .pageSpacer{height:320px}
  </style>
</head>
<body>
  <div class="splitRoot">
    <div class="pane" id="originalPane"></div>
    <div class="pane"><div class="contentWrap" id="content"></div></div>
  </div>
  <div class="pageSpacer"></div>
  <script>
    (function() {
      const contentEl = document.getElementById("content");
      const originalEl = document.getElementById("originalPane");
      contentEl.innerHTML = window.previewData || "";
      
      const sources = window.sourcesData || [];
      const apiBase = ${JSON.stringify(API_BASE)};
      const jobIdPath = ${JSON.stringify(jobIdPath)};

      function loadCss(href) {
        return new Promise((resolve, reject) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = href;
          link.onload = resolve;
          link.onerror = reject;
          document.head.appendChild(link);
        });
      }

      function loadScript(src) {
        return new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = src;
          s.async = true;
          s.onload = resolve;
          s.onerror = reject;
          document.body.appendChild(s);
        });
      }

      // 渲染左侧原始文件（优先使用合并PDF，否则使用原始PDF或图片）
      async function renderOriginal() {
        if (!jobIdPath) {
          originalEl.textContent = "无原始文件";
          return;
        }
        try {
          const resp = await fetch(apiBase + "/api/history/assets?id=" + encodeURIComponent(jobIdPath));
          const data = await resp.json();
          const files = (data && data.files) || [];
          if (!files.length) {
            originalEl.textContent = "无原始文件";
            return;
          }
          // 优先选择合并PDF；其次选择原始PDF；最后选择第一张图片
          const mergedPdf = files.find(f => f.type === "merged_pdf");
          const pdf = files.find(f => f.type === "pdf");
          const toShow = mergedPdf || pdf || files.find(f => f.type === "image");
          if (!toShow) {
            originalEl.textContent = "无可预览文件";
            return;
          }
          if (toShow.type === "merged_pdf" || toShow.type === "pdf") {
            const iframe = document.createElement("iframe");
            iframe.src = apiBase + "/" + toShow.url;
            iframe.style.width = "100%";
            iframe.style.height = "100%";
            iframe.style.minHeight = "100%";
            iframe.style.border = "none";
            originalEl.appendChild(iframe);
          } else {
            const img = document.createElement("img");
            img.src = apiBase + "/" + toShow.url;
            img.style.width = "100%";
            img.style.height = "auto";
            originalEl.appendChild(img);
          }
        } catch (e) {
          originalEl.textContent = "加载原始文件失败";
        }
      }

      async function init() {
        // 渲染左侧原始文件
        renderOriginal();

        // 滚动边界处理：当两个面板都到达底/顶后，继续滚动将滚动整个页面
        function canScroll(el, dy) {
          if (!el) return false;
          if (dy > 0) {
            return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
          } else if (dy < 0) {
            return el.scrollTop > 0;
          }
          return false;
        }
        const panes = Array.from(document.querySelectorAll(".pane"));
        panes.forEach((el) => {
          el.addEventListener(
            "wheel",
            (e) => {
              const dy = e.deltaY;
              if (canScroll(el, dy)) return; // 内部仍可滚动，保持默认
              const othersAtEdge = panes
                .filter((p) => p !== el)
                .every((p) => !canScroll(p, dy));
              if (othersAtEdge) {
                e.preventDefault();
                window.scrollBy({ top: dy, left: 0, behavior: "auto" });
              }
            },
            { passive: false }
          );
        });

        let loaded = false;
        // 尝试按顺序加载各个 CDN 的 KaTeX
        for (const s of sources) {
          try {
            await loadCss(s.css);
            await loadScript(s.js);
            await loadScript(s.render);
            if (typeof renderMathInElement === "function") {
              loaded = true;
              break;
            }
          } catch (e) {
            console.warn("Failed to load KaTeX from " + s.name);
          }
        }

        if (loaded) {
          // 渲染数学公式
          renderMathInElement(contentEl, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "\\\\[", right: "\\\\]", display: true },
              { left: "$", right: "$", display: false },
              { left: "\\\\(", right: "\\\\)", display: false },
            ],
            throwOnError: false,
            strict: "ignore" // 忽略严格模式，允许非标准 LaTeX（如公式中的中文）
          });
        } else {
          console.error("All KaTeX sources failed to load.");
        }
      }
      
      init();
    })();
  </script>
</body>
</html>`;

    previewWin.document.write(html);
    previewWin.document.close();
  } catch (err) {
    console.error("Preview error:", err);
    log("预览失败: " + err.message);
  }
}

// 通用 JSON POST 请求
async function postJson(url, data) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  return JSON.parse(text);
}

// 通用 FormData POST 请求（文件上传）
async function postForm(url, formData) {
  const resp = await fetch(url, { method: "POST", body: formData });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  return JSON.parse(text);
}

// 通用 GET 请求
async function getJson(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  return JSON.parse(text);
}

// 复制文本到剪贴板
async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 备选方案：使用 textarea
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

// 当前选中的上传文件夹
let selectedFolder = null;

// 设置选中的文件夹并更新 UI
function setSelectedFolder(files) {
  selectedFolder = files && files.length > 0 ? files : null;
  const folderNameEl = $("#folderName");
  if (selectedFolder) {
    // 显示文件夹名称（从第一个文件的webkitRelativePath获取）
    const firstFile = selectedFolder[0];
    const pathParts = (firstFile.webkitRelativePath || "").split("/");
    const folderName = pathParts.length > 0 ? pathParts[0] : firstFile.name;
    folderNameEl.textContent = folderName + ` (${selectedFolder.length} 个文件)`;
  } else {
    folderNameEl.textContent = "未选择";
  }
  $("#clearFolder").disabled = !selectedFolder;
  updateRunEnabled();
}

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

    // 显示文件夹模式的总进度
    if (status.progress && (status.progress.totalPages || status.progress.extractedPages)) {
      const tp = status.progress.totalPages ?? "?";
      const ep = status.progress.extractedPages ?? "?";
      $("#meta").textContent = `pages ${ep}/${tp}`;
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
      runGuard.running = false;
      runGuard.ocrDone = true;
      // 保存 res 数据供标记功能使用
      if (res.layoutParsingResults) {
        cachedResData = { result: { layoutParsingResults: res.layoutParsingResults } };
      }
      updateRunEnabled();
      const tl = $("#titleLabel");
      if (tl) tl.textContent = "识别结果";
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const pageCount = res.pages ?? "?";
      const answerTag = currentHasAnswer ? " · 有参考答案" : "";
      $("#meta").textContent = `pages ${pageCount} · ${elapsed}s${answerTag}`;
      $("#copy").disabled = !$("#output").value;
      updateSplitEnabled();
      updatePreviewEnabled();
      updateMarkEnabled();
      return;
    }
  }
}

// 显示历史记录对话框
function showHistoryModal() {
  const modal = $("#historyModal");
  if (!modal) return;
  modal.style.display = "";
}

// 隐藏历史记录对话框
function hideHistoryModal() {
  const modal = $("#historyModal");
  if (!modal) return;
  modal.style.display = "none";
}

// 打开并加载历史记录
async function openHistory() {
  const listEl = $("#historyList");
  if (!listEl) return;
  showHistoryModal();
  listEl.textContent = "加载中…";
  try {
    const data = await getJson(`${API_BASE}/api/history?limit=200`);
    const items = (data && data.items) || [];
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.textContent = "暂无历史记录";
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "historyItem";
      const main = document.createElement("div");
      main.className = "historyMain";
      const title = document.createElement("div");
      title.className = "historyTitle";
      title.textContent = item.folderName || item.id || "";
      const sub = document.createElement("div");
      sub.className = "historySub";
      sub.textContent = item.jobId || "";
      main.appendChild(title);
      main.appendChild(sub);
      row.appendChild(main);
      
      // 如果有分割结果，增加一个按钮
      if (item.hasSplit) {
        const btn = document.createElement("button");
        btn.textContent = "查看分割结果";
        btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          try {
            const detail = await getJson(
              `${API_BASE}/api/history/item?id=${encodeURIComponent(item.id)}&type=split`
            );
            $("#output").value = (detail && detail.text) || "";
            currentOutputDir = (detail && detail.outputDir) || null;
            currentContentType = "split";
            // 直接使用列表中的 hasAnswer（避免额外 API 调用）
            currentHasAnswer = (item && item.hasAnswer) || (detail && detail.hasAnswer) || false;
            const answerTag = currentHasAnswer ? " · 有参考答案" : "";
            const tl = $("#titleLabel");
            if (tl) tl.textContent = "分割结果";
            $("#meta").textContent = `history · ${detail.folderName || ""} · 分割${answerTag}`;
            $("#copy").disabled = !$("#output").value;
            updateSplitEnabled();
            updatePreviewEnabled();
            updateMarkEnabled();
            hideHistoryModal();
          } catch (e) {
            log(String(e && e.message ? e.message : e));
          }
        });
        row.appendChild(btn);
      }
      
      // 点击整行查看 OCR 结果
      row.addEventListener("click", async () => {
        try {
          const detail = await getJson(
            `${API_BASE}/api/history/item?id=${encodeURIComponent(item.id)}`
          );
          $("#output").value = (detail && detail.text) || "";
          currentOutputDir = (detail && detail.outputDir) || null;
          currentContentType = "ocr";
          // 直接使用列表中的 hasAnswer（避免额外 API 调用）
          currentHasAnswer = (item && item.hasAnswer) || (detail && detail.hasAnswer) || false;
          const answerTag = currentHasAnswer ? " · 有参考答案" : "";
          const tl = $("#titleLabel");
          if (tl) tl.textContent = "识别结果";
          $("#meta").textContent = `history · ${detail.folderName || ""}${answerTag}`;
          $("#copy").disabled = !$("#output").value;
          updateSplitEnabled();
          updatePreviewEnabled();
          updateMarkEnabled();
          hideHistoryModal();
        } catch (e) {
          log(String(e && e.message ? e.message : e));
        }
      });
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.textContent = "加载失败";
    log(String(e && e.message ? e.message : e));
  }
}

// 基于本地路径运行 OCR
async function runOcrPath(path) {
  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";
  cachedResData = null;
  updateMarkEnabled();

  setStatus("submitting");
  log("提交任务");
  const created = await postJson(`${API_BASE}/api/ocr`, { path });
  const jobId = created.jobId;
  log(`jobId=${jobId}`);
  await pollResult(jobId);
}

// 检查文件列表中是否包含图片
function hasImages(files) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif'];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (imageExts.some(ext => name.endsWith(ext))) {
      return true;
    }
  }
  return false;
}

// 基于文件夹上传运行 OCR
async function runOcrFolder(files) {
  // 检查是否包含图片
  if (!hasImages(files)) {
    alert("所选文件夹中没有图片文件，请选择包含图片的文件夹。");
    return;
  }

  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";
  cachedResData = null;
  updateMarkEnabled();

  setStatus("uploading");
  log("上传文件夹并提交任务");

  try {
    // 获取文件夹名称
    const firstFile = files[0];
    const pathParts = (firstFile.webkitRelativePath || "").split("/");
    const folderName = pathParts.length > 0 ? pathParts[0] : "upload";

    const fd = new FormData();
    fd.append("folderName", folderName);

    // 添加所有文件
    for (let i = 0; i < files.length; i++) {
      fd.append("files", files[i], files[i].webkitRelativePath || files[i].name);
    }

    const created = await postForm(`${API_BASE}/api/ocr/upload-folder`, fd);
    const jobId = created.jobId;
    log(`jobId=${jobId}`);
    await pollResult(jobId);
  } catch (e) {
    throw e;
  }
}

// 基于文件上传运行 OCR
async function runOcrFile(file) {
  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";
  cachedResData = null;
  updateMarkEnabled();

  setStatus("uploading");
  log("上传文件并提交任务");
  const fd = new FormData();
  fd.append("file", file, file.name);
  const created = await postForm(`${API_BASE}/api/ocr/upload`, fd);
  const jobId = created.jobId;
  log(`jobId=${jobId}`);
  await pollResult(jobId);
}

// “识别”按钮点击事件
$("#run").addEventListener("click", async () => {
  const path = $("#path").value.trim();
  try {
    if (runGuard.running) {
      alert("正在识别，请等待完成后再开始下一个文件");
      return;
    }
    if (runGuard.splitting) {
      alert("文本分割进行中，分割完成后再开始新的识别");
      return;
    }
    runGuard.running = true;
    runGuard.ocrDone = false;
    runGuard.splitDone = false;
    updateRunEnabled();
    $("#split").disabled = true;
    
    if (selectedFolder) {
      // 上传文件夹
      await runOcrFolder(selectedFolder);
      return;
    }
    if (!path) {
      alert("请选择文件夹或输入文件夹路径");
      return;
    }
    await runOcrPath(path);
  } catch (e) {
    runGuard.running = false;
    setStatus("error");
    log(String(e && e.message ? e.message : e));
    updateRunEnabled();
  }
});

// 文件夹选择相关事件
$("#browse").addEventListener("click", () => $("#folder").click());
$("#folder").addEventListener("change", (e) => {
  const files = e.target.files;
  setSelectedFolder(files);
});
$("#clearFolder").addEventListener("click", () => {
  $("#folder").value = "";
  setSelectedFolder(null);
});
setSelectedFolder(null);
$("#path").addEventListener("input", () => updateRunEnabled());

// 更新"识别"按钮的启用状态
function updateRunEnabled() {
  const runEl = $("#run");
  if (!runEl) return;
  const pathEl = $("#path");
  const hasInput =
    !!selectedFolder || !!(pathEl && (pathEl.value || "").trim());
  runEl.disabled = runGuard.running || runGuard.splitting || !hasInput;
}

// 轮询 Coze 任务结果
async function pollCoze(jobId) {
  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    const status = await getJson(`${API_BASE}/api/coze/${jobId}`);
    if (status.state === "failed") {
      throw new Error(status.error || "failed");
    }
    if (status.state === "done") {
      const res = status.result || {};
      return res.text || "";
    }
  }
}

// “分割文本”按钮点击事件
$("#split").addEventListener("click", async () => {
  const subject = ($("#subject").value || "").trim();
  if (!subject) {
    alert("请选择学科");
    return;
  }
  const text = ($("#output").value || "").trim();
  if (!text) {
    alert("没有可分割的文本");
    return;
  }
  $("#split").disabled = true;
  try {
    runGuard.splitting = true;
    updateRunEnabled();
    setStatus("coze");
    log(`分割文本：提交任务 (hasAnswer=${currentHasAnswer})`);
    const created = await postJson(`${API_BASE}/api/coze/run`, {
      subject,
      text,
      outputDir: currentOutputDir,
      hasAnswer: currentHasAnswer,
    });
    const jobId = created.jobId;
    log(`cozeJobId=${jobId}`);
    log("分割文本：等待结果");
    const finalText = await pollCoze(jobId);
    $("#output").value = finalText;
    currentContentType = "split";
    runGuard.splitDone = true;
    runGuard.splitting = false;
    updateRunEnabled();
    const tl = $("#titleLabel");
    if (tl) tl.textContent = "分割结果";
    $("#copy").disabled = !$("#output").value;
    updateSplitEnabled();
    updatePreviewEnabled();
    log("分割文本：完成");
  } catch (e) {
    runGuard.splitting = false;
    updateRunEnabled();
    updateSplitEnabled();
    log(String(e && e.message ? e.message : e));
  }
});

// 输入变化时更新按钮状态
$("#subject").addEventListener("change", updateSplitEnabled);
$("#output").addEventListener("input", updateSplitEnabled);
updateSplitEnabled();

$("#preview").addEventListener("click", () => openPreviewWindow());
$("#output").addEventListener("input", () => {
  updatePreviewEnabled();
});
updatePreviewEnabled();
updateRunEnabled();

// “复制”按钮点击事件
$("#copy").addEventListener("click", async () => {
  const text = $("#output").value;
  if (!text) return;
  try {
    await copyText(text);
    log("已复制到剪贴板");
  } catch (e) {
    log("复制失败");
  }
});

// 历史记录相关事件
$("#history").addEventListener("click", openHistory);
$("#historyClose").addEventListener("click", hideHistoryModal);
$("#historyModal").addEventListener("click", (e) => {
  if (e.target === $("#historyModal")) hideHistoryModal();
});

// 标记功能
let cachedResData = null;

function updateMarkEnabled() {
  const markEl = $("#mark");
  if (!markEl) return;
  markEl.disabled = !currentOutputDir;
}

async function loadResData() {
  if (cachedResData) return cachedResData;
  const jobIdPath = getJobIdPath();
  if (!jobIdPath) {
    log("无法获取任务路径");
    return null;
  }
  try {
    // 获取该任务下的所有文件
    const resp = await fetch(API_BASE + "/api/history/assets?id=" + encodeURIComponent(jobIdPath));
    if (!resp.ok) throw new Error("failed to load assets");
    const data = await resp.json();
    const files = (data && data.files) || [];

    // 过滤出所有 res_*.txt 文件
    const resFiles = files.filter(f => f.name && f.name.startsWith("res_") && f.name.endsWith(".txt"));

    log(`找到 res 文件: ${resFiles.length} 个`);
    
    const result = { result: { layoutParsingResults: [] } };

    // 遍历所有 res 文件并解析
    for (const resFile of resFiles) {
      log(`加载文件: ${resFile.name}`);
      try {
        // resFile.url 已经包含了完整路径
        const resResp = await fetch(API_BASE + "/" + resFile.url);
        if (!resResp.ok) {
          log(`加载失败: ${resResp.status}`);
          continue;
        }
        const text = await resResp.text();
        log(`文件内容长度: ${text.length}`);

        const lines = text.split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.result?.layoutParsingResults) {
              // 为每个结果添加来源文件信息
              for (const layoutResult of parsed.result.layoutParsingResults) {
                layoutResult._sourceFile = resFile.name;
                // 同时设置到 parsing_res_list 中的每个 item
                const parsingResList = layoutResult.prunedResult?.parsing_res_list || [];
                for (const item of parsingResList) {
                  item._sourceFile = resFile.name;
                }
              }
              result.result.layoutParsingResults.push(...parsed.result.layoutParsingResults);
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        log(`加载 ${resFile.name} 失败: ${e.message}`);
        continue;
      }
    }

    cachedResData = result;
    return cachedResData;
  } catch (e) {
    log("加载res.txt失败: " + e.message);
    return null;
  }
}

function exactMatch(text, query) {
  if (!text || !query) return false;
  // 完全匹配：文本中包含查询字符串
  return text.includes(query);
}

function fuzzyMatch(text, query) {
  if (!text || !query) return false;
  // 规范化：统一换行符，压缩多个空白为单个空格
  // 处理真实换行符 \n \r 和字面字符串 \n
  const normalize = (str) => str
    .replace(/\\n/g, '\n')  // 字面 \n 转真实换行
    .replace(/\r\n?/g, '\n') // Windows \r\n 和旧 Mac \r 转 \n
    .replace(/\s+/g, ' ')    // 压缩空白为单个空格
    .trim();
  const normalizedText = normalize(text);
  const normalizedQuery = normalize(query);
  return normalizedText.toLowerCase().includes(normalizedQuery.toLowerCase());
}

async function highlightBlocks(blocksWithPage, query) {
  const jobIdPath = getJobIdPath();
  if (!jobIdPath) {
    alert("无法获取任务路径");
    return;
  }

  const matchedBlocks = [];
  
  for (const { block, pageIndex } of blocksWithPage) {
    const content = block.block_content || "";
    if (fuzzyMatch(content, query)) {
      matchedBlocks.push({ ...block, pageIndex });
    }
  }

  if (matchedBlocks.length === 0) {
    alert("未找到匹配的内容");
    return;
  }

  // 获取所有匹配的图片文件
  const sourceFiles = new Set();
  for (const block of matchedBlocks) {
    if (block._sourceFile) {
      // 从 res_answer_xxx.jpg.txt 或 res_xxx.jpg.txt 中提取图片名称 xxx.jpg
      let imgName = block._sourceFile.replace(/^res_/, '').replace(/\.txt$/, '');
      // 去掉 answer_ 前缀（参考答案文件名有此前缀）
      imgName = imgName.replace(/^answer_/, '');
      sourceFiles.add(imgName);
    }
  }

  try {
    const resp = await fetch(API_BASE + "/api/history/assets?id=" + encodeURIComponent(jobIdPath));
    const data = await resp.json();
    const files = (data && data.files) || [];

    // 过滤出需要高亮的图片文件
    // 优先使用 imgs/ 目录中的原图
    let targetFiles = files.filter(f => {
      if (f.type !== "image") return false;
      return sourceFiles.has(f.name);
    });

    // 如果 imgs/ 没有，尝试从 api_image 类型查找
    if (targetFiles.length === 0) {
      targetFiles = files.filter(f => {
        if (f.type !== "api_image") return false;
        return sourceFiles.has(f.name);
      });
    }

    // 如果还是没有，尝试参考答案目录
    if (targetFiles.length === 0) {
      targetFiles = files.filter(f => {
        if (f.type !== "image") return false;
        if (f.name && f.name.includes("参考答案")) {
          // JavaScript 获取文件名：取最后一个路径段
          const basename = f.name.replace(/\\/g, '/').split('/').pop();
          return sourceFiles.has(basename);
        }
        return false;
      });
    }

    if (targetFiles.length > 0) {
      await highlightImages(jobIdPath, targetFiles, matchedBlocks);
    } else {
      alert("未找到原始图片文件");
    }

  } catch (e) {
    log("标记失败: " + e.message);
    alert("标记失败: " + e.message);
  }
}

async function highlightImages(jobIdPath, sourceFiles, matchedBlocks) {
  // 按图片名称分组匹配块
  const blocksByImage = {};
  for (const block of matchedBlocks) {
    if (block._sourceFile) {
      let imgName = block._sourceFile.replace(/^res_/, '').replace(/\.txt$/, '');
      // 去掉 answer_ 前缀（参考答案文件名有此前缀）
      imgName = imgName.replace(/^answer_/, '');
      if (!blocksByImage[imgName]) {
        blocksByImage[imgName] = [];
      }
      blocksByImage[imgName].push(block);
    }
  }
  
  const highlightWin = window.open("", "_blank");
  if (!highlightWin) {
    alert("弹出窗口被拦截，请允许弹出窗口。");
    return;
  }
  
  // 构建 HTML
  let htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>标记结果 - PaddleDev</title>
  <style>
    body{margin:0;padding:20px;background:#333;min-height:100vh;display:flex;flex-direction:column;align-items:center}
    h2{color:#fff;margin:0 0 20px;font-family:system-ui,sans-serif}
    .page-container{margin-bottom:30px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.3);border-radius:4px;overflow:hidden}
    canvas{display:block;max-width:100%;height:auto}
    .page-label{background:#222;color:#fff;padding:8px 16px;font-family:system-ui,sans-serif;font-size:14px}
    .loading{color:#fff;font-size:14px}
  </style>
</head>
<body>
  <h2>标记结果</h2>
  <div id="pages"><p class="loading">加载中...</p></div>
  <script>
    const API_BASE = ${JSON.stringify(API_BASE)};
    const jobIdPath = ${JSON.stringify(jobIdPath)};
    const sourceFiles = ${JSON.stringify(sourceFiles)};
    const blocksByImage = ${JSON.stringify(blocksByImage)};
    
    async function loadImageWithHighlight(imgUrl, blocks, canvas) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          
          // 绘制高亮
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = "#ffff00";
          for (const block of blocks) {
            const bbox = block.block_bbox;
            if (bbox && bbox.length === 4) {
              ctx.fillRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
            }
          }
          
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#ff0000";
          ctx.lineWidth = 3;
          for (const block of blocks) {
            const bbox = block.block_bbox;
            if (bbox && bbox.length === 4) {
              ctx.strokeRect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
            }
          }
          resolve();
        };
        img.onerror = reject;
        img.src = imgUrl;
      });
    }
    
    async function init() {
      const container = document.getElementById("pages");
      container.innerHTML = "";
      
      for (const file of sourceFiles) {
        const url = API_BASE + "/" + file.url;
        const blocks = blocksByImage[file.name] || [];
        
        const pageDiv = document.createElement("div");
        pageDiv.className = "page-container";
        
        const labelDiv = document.createElement("div");
        labelDiv.className = "page-label";
        labelDiv.textContent = file.name + (blocks.length > 0 ? " - " + blocks.length + "处匹配" : "");
        
        const canvas = document.createElement("canvas");
        
        pageDiv.appendChild(labelDiv);
        pageDiv.appendChild(canvas);
        container.appendChild(pageDiv);
        
        try {
          await loadImageWithHighlight(url, blocks, canvas);
        } catch (e) {
          canvas.width = 400;
          canvas.height = 200;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#f0f0f0";
          ctx.fillRect(0, 0, 400, 200);
          ctx.fillStyle = "#666";
          ctx.font = "14px sans-serif";
          ctx.fillText("图片加载失败", 150, 100);
        }
      }
    }
    
    init();
  <\/script>
</body>
</html>`;
  
  highlightWin.document.write(htmlContent);
  highlightWin.document.close();
}

async function highlightPdf(pdfUrl, matchedBlocks, jobIdPath) {
  let pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    log("加载 PDF.js 库...");
    const cdnList = [
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
      "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js"
    ];
    
    for (const cdn of cdnList) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = cdn;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("load failed"));
          document.head.appendChild(s);
        });
        pdfjsLib = window.pdfjsLib;
        if (pdfjsLib) break;
      } catch (e) {
        continue;
      }
    }
    
    if (!pdfjsLib) {
      throw new Error("无法加载 PDF.js 库");
    }
    
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsLib.GlobalWorkerOptions.workerSrc || 
        cdnList[0].replace("pdf.min.js", "pdf.worker.min.js");
    } catch (e) {
      // worker 可能不需要
    }
  }
  
  const loadingTask = pdfjsLib.getDocument(pdfUrl);
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  log(`PDF 共 ${numPages} 页`);
  
  const highlightWin = window.open("", "_blank");
  if (!highlightWin) {
    alert("弹出窗口被拦截，请允许弹出窗口。");
    return;
  }
  
  const pageNumbers = new Set();
  for (const block of matchedBlocks) {
    const pageInfo = block.pageIndex;
    if (pageInfo !== undefined && pageInfo !== null) {
      pageNumbers.add(pageInfo);
    }
  }
  
  if (pageNumbers.size === 0) {
    for (let i = 1; i <= numPages; i++) {
      pageNumbers.add(i);
    }
  }
  
  const sortedPages = Array.from(pageNumbers).sort((a, b) => a - b);
  const pageCanvases = [];
  
  for (const pageNum of sortedPages) {
    const page = await pdf.getPage(pageNum);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    
    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;
    
    pageCanvases.push({ pageNum, canvas, viewport, scale });
  }
  
  for (const { pageNum, canvas, viewport, scale } of pageCanvases) {
    const ctx = canvas.getContext("2d");
    
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#ffff00";
    
    for (const block of matchedBlocks) {
      if (block.pageIndex !== pageNum) continue;
      const bbox = block.block_bbox;
      if (bbox && bbox.length === 4) {
        const x = bbox[0] * scale;
        const y = bbox[1] * scale;
        const w = (bbox[2] - bbox[0]) * scale;
        const h = (bbox[3] - bbox[1]) * scale;
        ctx.fillRect(x, y, w, h);
      }
    }
    
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 3 * scale / 1.5;
    
    for (const block of matchedBlocks) {
      if (block.pageIndex !== pageNum) continue;
      const bbox = block.block_bbox;
      if (bbox && bbox.length === 4) {
        const x = bbox[0] * scale;
        const y = bbox[1] * scale;
        const w = (bbox[2] - bbox[0]) * scale;
        const h = (bbox[3] - bbox[1]) * scale;
        ctx.strokeRect(x, y, w, h);
      }
    }
  }
  
  highlightWin.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>PDF 标记结果 - PaddleDev</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;padding:20px;background:#333;min-height:100vh;display:flex;flex-direction:column;align-items:center}
    h2{color:#fff;margin:0 0 20px;font-family:system-ui,sans-serif}
    .page-container{margin-bottom:30px;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,0.3);border-radius:4px;overflow:hidden}
    canvas{display:block;max-width:100%;height:auto}
    .page-label{background:#222;color:#fff;padding:8px 16px;font-family:system-ui,sans-serif;font-size:14px}
  </style>
</head>
<body>
  <h2>PDF 标记结果</h2>
  <div id="pages"></div>
  <script>
    const pages = ${JSON.stringify(pageCanvases.map(p => ({
      pageNum: p.pageNum,
      dataUrl: p.canvas.toDataURL("image/png")
    })))};
    const container = document.getElementById("pages");
    pages.forEach(page => {
      const div = document.createElement("div");
      div.className = "page-container";
      div.innerHTML = '<div class="page-label">第 ' + page.pageNum + ' 页</div>';
      const img = document.createElement("img");
      img.src = page.dataUrl;
      img.alt = "第 " + page.pageNum + " 页";
      div.appendChild(img);
      container.appendChild(div);
    });
  <\/script>
</body>
</html>`);
  highlightWin.document.close();
}

function getJobIdPath() {
  if (!currentOutputDir) return null;
  const rel = String(currentOutputDir).replace(/\\/g, "/");
  const idx = rel.toLowerCase().indexOf("/paddlelog/");
  if (idx >= 0) {
    const tail = rel.slice(idx + "/paddlelog/".length);
    const segs = tail.split("/").filter(Boolean);
    if (segs.length >= 2) return `${segs[0]}/${segs[1]}`;
  }
  const segs = rel.split("/").filter(Boolean);
  if (segs.length >= 2) {
    const last = segs[segs.length - 1];
    const prev = segs[segs.length - 2];
    return `${prev}/${last}`;
  }
  return null;
}

async function doMark() {
  const query = ($("#markText").value || "").trim();
  if (!query) {
    alert("请输入要标记的文字");
    return;
  }
  
  $("#mark").disabled = true;
  setStatus("marking");
  log(`标记: "${query}"`);
  
  try {
    const resData = await loadResData();
    if (!resData) {
      throw new Error("无法加载res.txt");
    }
    const results = resData.result?.layoutParsingResults || [];
    const blocksWithPage = [];
    for (let pageIdx = 0; pageIdx < results.length; pageIdx++) {
      const result = results[pageIdx];
      const pageIndex = pageIdx + 1;
      const parsingResList = result.prunedResult?.parsing_res_list || [];
      for (const item of parsingResList) {
        if (item.block_content) {
          blocksWithPage.push({ block: item, pageIndex });
        }
      }
    }
    
    if (blocksWithPage.length === 0) {
      throw new Error("res.txt中没有找到block_content");
    }
    
    await highlightBlocks(blocksWithPage, query);
    
    setStatus("done");
    log("标记完成");
  } catch (e) {
    setStatus("error");
    log("标记失败: " + e.message);
  } finally {
    updateMarkEnabled();
  }
}

$("#markText").addEventListener("input", updateMarkEnabled);
$("#mark").addEventListener("click", doMark);
updateMarkEnabled();
