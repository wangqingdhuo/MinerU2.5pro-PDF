window.onerror = function(msg, url, line, col, error) {
  log(`Error: ${msg} at ${line}:${col}`);
};

// 后端 API 地址配置
const API_HOST = window.location.hostname || "127.0.0.1";
const API_BASE = ""; // 空字符串表示相对路径（同源请求）

// DOM 操作简写工具
const $ = (s) => document.querySelector(s);
// 日志输出工具
const log = (m) => {
  const el = $("#log");
  el.textContent += m + "\n";
  el.scrollTop = el.scrollHeight;
};
// 设置当前状态显示
const setStatus = (s) => ($("#statusIndicator").textContent = s);

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
  const fileInput = $("#file");
  const hasFile = fileInput && fileInput.files && fileInput.files.length > 0;
  const hasInput =
    (typeof selectedFolder !== "undefined" && !!selectedFolder) || hasFile || !!(pathEl && (pathEl.value || "").trim());
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
  // 预览按钮：必须提取完毕有了结果（右侧文本框有内容）且上传了文件，才能开启预览
  const previewEl = $("#preview");
  if (previewEl) {
    const outEl = $("#output");
    previewEl.disabled = !(outEl && outEl.value.trim());
  }
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

    const previewContent = content;

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
  previewWin.previewData = previewContent;
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

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function mdToHtml(md) {
        const lines = String(md || "").replace(/\\r\\n/g, "\\n").split("\\n");
        const out = [];
        let buf = [];

        const flushPara = () => {
          if (!buf.length) return;
          const text = buf.join(" ").trim();
          if (!text) {
            buf = [];
            return;
          }
          out.push("<p>" + renderInline(text) + "</p>");
          buf = [];
        };

        const renderInline = (text) => {
          let t = escapeHtml(text);
          t = t.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, (m, alt, src) => {
            const a = escapeHtml(alt || "");
            const u = escapeHtml(String(src || "").trim());
            return "<img alt=\"" + a + "\" src=\"" + u + "\">";
          });
          t = t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, (m, label, href) => {
            const l = escapeHtml(label || "");
            const u = escapeHtml(String(href || "").trim());
            return "<a href=\"" + u + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + l + "</a>";
          });
          t = t.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
          t = t.replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
          return t;
        };

        for (const rawLine of lines) {
          const line = rawLine || "";
          const mHeading = line.match(/^(#{1,6})\\s+(.*)$/);
          if (mHeading) {
            flushPara();
            const level = mHeading[1].length;
            out.push("<h" + level + ">" + renderInline(mHeading[2] || "") + "</h" + level + ">");
            continue;
          }

          if (!line.trim()) {
            flushPara();
            continue;
          }

          buf.push(line.trim());
        }
        flushPara();
        return out.join("\\n");
      }

      function fixImgUrls(rootEl) {
        if (!rootEl) return;
        const imgs = Array.from(rootEl.querySelectorAll("img"));
        for (const img of imgs) {
          const src = (img.getAttribute("src") || "").trim();
          if (!src) continue;
          if (src.startsWith("http") || src.startsWith("data:") || src.startsWith("blob:")) continue;
          if (src.startsWith("output/imgs/")) {
            if (jobIdPath) {
              img.setAttribute("src", apiBase + "/output/" + jobIdPath + "/" + src);
            }
            continue;
          }
          if (src.startsWith("output/")) {
            img.setAttribute("src", apiBase + "/" + src);
          }
        }
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
          // 只选择 PDF（优先合并PDF；其次原始PDF）
          const mergedPdf = files.find(f => f.type === "merged_pdf");
          const pdf = files.find(f => f.type === "pdf");
          const toShow = mergedPdf || pdf;
          if (!toShow) {
            originalEl.textContent = "无可预览 PDF（请确认任务目录中存在 merged.pdf 或原始 pdf）";
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
          }
        } catch (e) {
          originalEl.textContent = "加载原始文件失败";
        }
      }

      async function init() {
        // 渲染左侧原始文件
        renderOriginal();
        contentEl.innerHTML = mdToHtml(window.previewData || "");
        fixImgUrls(contentEl);

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
      $("#meta").textContent = `页数 ${ep}/${tp}`;
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
      updateRunEnabled();
      const tl = $("#titleLabel");
      if (tl) tl.textContent = "识别结果";
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const pageCount = res.pages ?? "?";
      const answerTag = currentHasAnswer ? " · 有参考答案" : "";
      $("#meta").textContent = `页数 ${pageCount} · ${elapsed}s${answerTag}`;
      $("#copy").disabled = !$("#output").value;
      updateSplitEnabled();
      updatePreviewEnabled();
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

// 获取 OCR Token（优先使用页面输入的，没有则返回 null）
function getOcrToken() {
  const tokenInput = $("#ocrToken");
  if (tokenInput && tokenInput.value && tokenInput.value.trim()) {
    return tokenInput.value.trim();
  }
  return null;
}

// 基于本地路径运行 OCR
async function runOcrPath(path) {
  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";

  setStatus("submitting");
  log("提交任务");
  const token = getOcrToken();
  const body = { path };
  if (token) {
    body.token = token;
    log("使用自定义 Token");
  }

  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["X-PaddleOCR-Token"] = token;
  }
  const langEl = $("#language");
  if (langEl && langEl.value) {
    headers["X-Language"] = langEl.value;
  }

  const resp = await fetch(`${API_BASE}/api/ocr`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  const created = JSON.parse(text);

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

    // 获取 token
    const token = getOcrToken();
    if (token) {
      log("使用自定义 Token");
    }

    // 构建请求头
    const headers = {};
    if (token) {
      headers["X-PaddleOCR-Token"] = token;
    }
    const langEl = $("#language");
    if (langEl && langEl.value) {
      headers["X-Language"] = langEl.value;
    }

    const resp = await fetch(`${API_BASE}/api/ocr/upload-folder`, {
      method: "POST",
      body: fd,
      headers: headers
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(text || String(resp.status));
    const created = JSON.parse(text);
    const jobId = created.jobId;
    log(`jobId=${jobId}`);
    await pollResult(jobId);
  } catch (e) {
    throw e;
  }
}

// 基于文件上传运行 OCR
async function runOcrFile(file) {
  const ext = file.name.toLowerCase();
  if (!ext.endsWith('.jpg') && !ext.endsWith('.png') && !ext.endsWith('.jpeg') && !ext.endsWith('.pdf') && !ext.endsWith('.bmp')) {
    throw new Error("仅支持上传图片或PDF文件");
  }

  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";

  setStatus("uploading");
  log(`正在上传文件: ${file.name}`);
  const fd = new FormData();
  fd.append("file", file, file.name);

  // 获取 token
  const token = getOcrToken();
  if (token) {
    log("使用自定义 Token");
  }

  // 构建请求头
  const headers = {};
  if (token) {
    headers["X-PaddleOCR-Token"] = token;
  }
  const langEl = $("#language");
  if (langEl && langEl.value) {
    headers["X-Language"] = langEl.value;
  }

  const resp = await fetch(`${API_BASE}/api/ocr/upload`, {
    method: "POST",
    body: fd,
    headers: headers
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  const created = JSON.parse(text);
  const jobId = created.jobId;
  log(`jobId=${jobId}`);
  await pollResult(jobId);
}

// “识别”按钮点击事件
$("#run").addEventListener("click", async () => {
  const path = $("#path").value.trim();
  const fileInput = $("#file");
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
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      // 上传单文件
      await runOcrFile(fileInput.files[0]);
      return;
    }
    if (!path) {
      alert("请选择文件、文件夹或输入本地路径");
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

// 绑定事件
$("#browseFile").addEventListener("click", () => {
  $("#file").click();
});

$("#file").addEventListener("change", (e) => {
  const files = e.target.files;
  if (files && files.length > 0) {
    const f = files[0];
    $("#fileName").textContent = f.name;
    $("#fileName").title = f.name;
    $("#clearFile").disabled = false;
    $("#path").value = ""; // 清空路径框，以文件上传为准
  } else {
    clearFile();
  }
  updateRunEnabled();
});

$("#clearFile").addEventListener("click", clearFile);

function clearFile() {
  $("#file").value = "";
  $("#fileName").textContent = "未选择文件";
  $("#fileName").title = "";
  $("#clearFile").disabled = true;
  updateRunEnabled();
}
$("#path").addEventListener("input", () => updateRunEnabled());

// 更新"识别"按钮的启用状态
function updateRunEnabled() {
  const runEl = $("#run");
  if (!runEl) return;
  const pathEl = $("#path");
  const fileInput = $("#file");
  const hasFile = fileInput && fileInput.files && fileInput.files.length > 0;
  const hasInput = hasFile || !!(pathEl && (pathEl.value || "").trim());
  runEl.disabled = runGuard.running || runGuard.splitting || !hasInput;

  // 预览按钮：依赖于 updatePreviewEnabled
  updatePreviewEnabled();
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

// ==========================================
// 查重功能
// ==========================================
function updateDuplicateCheckEnabled() {
  const checkEl = $("#checkDuplicate");
  if (!checkEl) return;
  // 直接读取当前文本框中的文本（可能已被用户修改，或者经过了“分割”步骤被更新过）
  const text = $("#output").value.trim();
  checkEl.disabled = !text;
}

async function doDuplicateCheck() {
  const text = $("#output").value.trim();
  if (!text) {
    alert("没有提取的文本可供查重");
    return;
  }
  
  $("#checkDuplicate").disabled = true;
  setStatus("checking");
  log("开始查重...");
  
  try {
    // 查重发送的直接就是 text（也就是当前右侧面板显示的最终文本）
    const resp = await fetch(API_BASE + "/api/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });
    
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(errText || String(resp.status));
    }
    
    const data = await resp.json();
    log(`查重完成: 总共 ${data.total} 题，重复 ${data.success_count} 题，未重复 ${data.failed_count} 题`);
    
    // 更新结果回显到文本框
    if (data.marked_txt) {
      $("#output").value = data.marked_txt;
    }
    setStatus("done");
  } catch (e) {
    setStatus("error");
    log("查重失败: " + e.message);
  } finally {
    updateDuplicateCheckEnabled();
  }
}

const checkDuplicateBtn = $("#checkDuplicate");
if (checkDuplicateBtn) {
  checkDuplicateBtn.addEventListener("click", doDuplicateCheck);
}
$("#output").addEventListener("input", updateDuplicateCheckEnabled);
updateDuplicateCheckEnabled();
