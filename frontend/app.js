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

      // 渲染左侧原始文件（PDF 或图片）
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
          // 优先选择 PDF；否则选择第一张图片
          const pdf = files.find(f => f.type === "pdf");
          const toShow = pdf || files.find(f => f.type === "image");
          if (!toShow) {
            originalEl.textContent = "无可预览文件";
            return;
          }
          if (toShow.type === "pdf") {
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

// 当前选中的上传文件
let selectedFile = null;

// 设置选中的文件并更新 UI
function setSelectedFile(file) {
  selectedFile = file || null;
  $("#fileName").textContent = selectedFile ? selectedFile.name : "未选择";
  $("#clearFile").disabled = !selectedFile;
  updateRunEnabled();
}

// 轮询 OCR 任务结果
async function pollResult(jobId) {
  const startedAt = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 1200));
    const status = await getJson(`${API_BASE}/api/ocr/${jobId}`);
    setStatus(status.state || "unknown");

    // 显示提取进度
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
      runGuard.running = false;
      runGuard.ocrDone = true;
      updateRunEnabled();
      const tl = $("#titleLabel");
      if (tl) tl.textContent = "识别结果";
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      $("#meta").textContent = `pages ${res.pages ?? "?"} · ${elapsed}s`;
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
            const tl = $("#titleLabel");
            if (tl) tl.textContent = "分割结果";
            $("#meta").textContent = `history · ${detail.folderName || ""} · 分割`;
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
          const tl = $("#titleLabel");
          if (tl) tl.textContent = "识别结果";
          $("#meta").textContent = `history · ${detail.folderName || ""}`;
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

// 基于本地路径运行 OCR
async function runOcrPath(path) {
  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";

  setStatus("submitting");
  log("提交任务");
  const created = await postJson(`${API_BASE}/api/ocr`, { path });
  const jobId = created.jobId;
  log(`jobId=${jobId}`);
  await pollResult(jobId);
}

// 基于文件上传运行 OCR
async function runOcrFile(file) {
  $("#output").value = "";
  $("#meta").textContent = "";
  $("#copy").disabled = true;
  $("#log").textContent = "";

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
    
    if (selectedFile) {
      await runOcrFile(selectedFile);
      return;
    }
    if (!path) {
      alert("请输入文件路径或选择文件");
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

// 文件选择相关事件
$("#browse").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  setSelectedFile(f || null);
});
$("#clearFile").addEventListener("click", () => {
  $("#file").value = "";
  setSelectedFile(null);
});
setSelectedFile(null);
$("#path").addEventListener("input", () => updateRunEnabled());

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
    log("分割文本：提交任务");
    const created = await postJson(`${API_BASE}/api/coze/run`, {
      subject,
      text,
      outputDir: currentOutputDir,
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
