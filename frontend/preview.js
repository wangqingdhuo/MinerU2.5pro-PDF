(() => {
  const pdfHost = document.getElementById("pdfHost");
  const mdHost = document.getElementById("mdHost");

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(text) {
    let t = escapeHtml(text);
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
      const a = escapeHtml(alt || "");
      const u = escapeHtml(String(src || "").trim());
      return "<img alt=\"" + a + "\" src=\"" + u + "\">";
    });
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
      const l = escapeHtml(label || "");
      const u = escapeHtml(String(href || "").trim());
      return "<a href=\"" + u + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + l + "</a>";
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return t;
  }

  function mdToHtml(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let buf = [];

    const flushPara = () => {
      if (!buf.length) return;
      const text = buf.join(" ").trim();
      buf = [];
      if (!text) return;
      out.push("<p>" + renderInline(text) + "</p>");
    };

    for (const rawLine of lines) {
      const line = rawLine || "";
      const mHeading = line.match(/^(#{1,6})\s+(.*)$/);
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
    return out.join("\n");
  }

  function fixImgUrls(rootEl, jobIdPath) {
    const imgs = Array.from(rootEl.querySelectorAll("img"));
    for (const img of imgs) {
      const src = (img.getAttribute("src") || "").trim();
      if (!src) continue;
      if (src.startsWith("http") || src.startsWith("data:") || src.startsWith("blob:")) continue;
      if (src.startsWith("output/imgs/")) {
        if (jobIdPath) {
          img.setAttribute("src", "/output/" + jobIdPath + "/" + src);
        }
        continue;
      }
      if (src.startsWith("output/")) {
        img.setAttribute("src", "/" + src);
      }
    }
  }

  async function renderPdf(jobIdPath) {
    if (!jobIdPath) {
      pdfHost.textContent = "无原始 PDF（需要先完成一次识别任务）";
      return;
    }
    try {
      const resp = await fetch("/api/history/assets?id=" + encodeURIComponent(jobIdPath));
      const data = await resp.json();
      const files = (data && data.files) || [];
      const mergedPdf = files.find((f) => f.type === "merged_pdf");
      const pdf = files.find((f) => f.type === "pdf");
      const toShow = mergedPdf || pdf;
      if (!toShow) {
        pdfHost.textContent = "无可预览 PDF";
        return;
      }
      const iframe = document.createElement("iframe");
      iframe.src = "/" + toShow.url;
      pdfHost.textContent = "";
      pdfHost.appendChild(iframe);
    } catch (e) {
      pdfHost.textContent = "加载 PDF 失败";
    }
  }

  function renderMarkdown(markdown, jobIdPath) {
    mdHost.innerHTML = mdToHtml(markdown || "");
    fixImgUrls(mdHost, jobIdPath);
    if (typeof renderMathInElement === "function") {
      renderMathInElement(mdHost, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
        strict: "ignore",
      });
    }
  }

  function handleData(payload) {
    const jobIdPath = payload && payload.jobIdPath ? String(payload.jobIdPath) : null;
    const markdown = payload && payload.markdown ? String(payload.markdown) : "";
    renderPdf(jobIdPath);
    renderMarkdown(markdown, jobIdPath);
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type !== "preview-data") return;
    handleData(d);
  });

  if (window.opener) {
    window.opener.postMessage({ type: "preview-ready" }, window.location.origin);
  } else {
    pdfHost.textContent = "无来源窗口";
  }
})();
