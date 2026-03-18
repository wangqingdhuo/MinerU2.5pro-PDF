window.onerror = function(msg, url, line, col, error) {
  log(`Error: ${msg} at ${line}:${col}`);
};

const API_HOST = window.location.hostname || "127.0.0.1";
const API_BASE = `http://${API_HOST}:8099`;

const $ = (s) => document.querySelector(s);
const log = (m) => {
  const el = $("#log");
  el.textContent += m + "\n";
  el.scrollTop = el.scrollHeight;
};
const setStatus = (s) => ($("#status").textContent = s);

let katexLoadPromise = null;
let currentOutputDir = null;
let currentContentType = "ocr";

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

function updateSplitEnabled() {
  const subjectEl = $("#subject");
  const splitEl = $("#split");
  const outEl = $("#output");
  if (!subjectEl || !splitEl || !outEl) return;
  const subject = (subjectEl.value || "").trim();
  const text = (outEl.value || "").trim();
  splitEl.disabled = !(subject && text);
}

function updatePreviewEnabled() {
  const previewEl = $("#preview");
  const outEl = $("#output");
  if (!previewEl || !outEl) return;
  previewEl.disabled = !(outEl.value || "").trim();
}

function openPreviewWindow() {
  try {
    const content = $("#output").value || "";
    console.log("Opening preview for content length:", content.length);
    
    const previewWin = window.open("", "_blank");
    if (!previewWin) {
      alert("弹出窗口被拦截，请允许弹出窗口。");
      return;
    }

    // Process content: Convert all local image paths to be relative to the OUTPUT_ROOT.
    const processedContent = content.replace(/src="([^"]+)"/g, (match, p1) => {
      // Skip already processed or remote URLs
      if (p1.startsWith("http")) return match;
      
      // Find the part of the path that is relative to the job output directory
      // e.g., "D:/paddlelog/filename/jobid/output/imgs/img.jpg" -> "filename/jobid/output/imgs/img.jpg"
      const relativePart = p1.split("/paddlelog/").pop();
      
      // Construct the final URL for the backend to serve
    return `src="${API_BASE}/output/${relativePart}"`;
  });

  // Compute current job id path for assets listing
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

  // Pass content and data to the new window object
  previewWin.previewData = processedContent;
  previewWin.sourcesData = sources; // Pass all available sources

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
    /* KaTeX specific styling to avoid overlapping */
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
  </style>
</head>
<body>
  <div class="splitRoot">
    <div class="pane" id="originalPane"></div>
    <div class="pane"><div class="contentWrap" id="content"></div></div>
  </div>
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

        let loaded = false;
        // Try each source until one works
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
          renderMathInElement(contentEl, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "\\\\[", right: "\\\\]", display: true },
              { left: "$", right: "$", display: false },
              { left: "\\\\(", right: "\\\\)", display: false },
            ],
            throwOnError: false,
            strict: "ignore" // Completely ignore strict mode for non-standard LaTeX (like Chinese in math)
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

async function postForm(url, formData) {
  const resp = await fetch(url, { method: "POST", body: formData });
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  return JSON.parse(text);
}

async function getJson(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  if (!resp.ok) throw new Error(text || String(resp.status));
  return JSON.parse(text);
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

let selectedFile = null;

function setSelectedFile(file) {
  selectedFile = file || null;
  $("#fileName").textContent = selectedFile ? selectedFile.name : "未选择";
  $("#clearFile").disabled = !selectedFile;
}

async function pollResult(jobId) {
  const startedAt = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 1200));
    const status = await getJson(`${API_BASE}/api/ocr/${jobId}`);
    setStatus(status.state || "unknown");

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

function showHistoryModal() {
  const modal = $("#historyModal");
  if (!modal) return;
  modal.style.display = "";
}

function hideHistoryModal() {
  const modal = $("#historyModal");
  if (!modal) return;
  modal.style.display = "none";
}

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

$("#run").addEventListener("click", async () => {
  const path = $("#path").value.trim();
  try {
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
    setStatus("error");
    log(String(e && e.message ? e.message : e));
  }
});

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
    const tl = $("#titleLabel");
    if (tl) tl.textContent = "分割结果";
    $("#copy").disabled = !$("#output").value;
    updateSplitEnabled();
    updatePreviewEnabled();
    log("分割文本：完成");
  } catch (e) {
    updateSplitEnabled();
    log(String(e && e.message ? e.message : e));
  }
});

$("#subject").addEventListener("change", updateSplitEnabled);
$("#output").addEventListener("input", updateSplitEnabled);
updateSplitEnabled();

$("#preview").addEventListener("click", () => openPreviewWindow());
$("#output").addEventListener("input", () => {
  updatePreviewEnabled();
});
updatePreviewEnabled();

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

$("#history").addEventListener("click", openHistory);
$("#historyClose").addEventListener("click", hideHistoryModal);
$("#historyModal").addEventListener("click", (e) => {
  if (e.target === $("#historyModal")) hideHistoryModal();
});
