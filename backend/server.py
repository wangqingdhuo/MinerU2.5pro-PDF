import json
import os
import re
import threading
import time
import uuid
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, unquote

import requests

# 服务器配置
HOST = "0.0.0.0"
PORT = 8099

# PaddleOCR API 配置
JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
MODEL = "PaddleOCR-VL-1.5"
TOKEN = os.environ.get("PADDLE_OCR_TOKEN") or "e562edec6395acd23974e5a6c3dcabead1b9d5e5"
# 输出目录，默认 D:\paddlelog
OUTPUT_ROOT = os.environ.get("PADDLE_LOG_DIR") or r"D:\paddlelog"
REQUEST_RETRIES = int(os.environ.get("PADDLE_OCR_RETRIES") or "5")
MAX_UPLOAD_BYTES_RAW = os.environ.get("PADDLE_UPLOAD_MAX_BYTES")
MAX_UPLOAD_BYTES = int(MAX_UPLOAD_BYTES_RAW) if MAX_UPLOAD_BYTES_RAW else None

# Coze (扣子) 工作流配置
COZE_RUN_URL = "https://api.coze.cn/v1/workflow/run"
COZE_HISTORY_URL_TEMPLATE = "https://api.coze.cn/v1/workflows/{workflow_id}/run_histories/{execute_id}"
COZE_TOKEN = os.environ.get("COZE_TOKEN") or "sat_GhO014DdwluXQePU92rIXnAaoM6tHesqcfvs6CvNoPkqMq8ubG3YIwyoPSPBBNlS"
COZE_WORKFLOW_ID = os.environ.get("COZE_WORKFLOW_ID") or "7618051893592293422"

# OCR 任务的可选负载参数
OPTIONAL_PAYLOAD = {
    "markdownIgnoreLabels": [
        "header",
        "header_image",
        "footer",
        "footer_image",
        "number",
        "footnote",
        "aside_text",
    ],
    "useDocOrientationClassify": False,
    "useDocUnwarping": False,
    "useLayoutDetection": True,
    "useChartRecognition": False,
    "useSealRecognition": True,
    "useOcrForImageBlock": False,
    "mergeTables": True,
    "relevelTitles": True,
    "layoutShapeMode": "auto",
    "promptLabel": "ocr",
    "repetitionPenalty": 1,
    "temperature": 0,
    "topP": 1,
    "minPixels": 147384,
    "maxPixels": 2822400,
    "layoutNms": True,
    "restructurePages": True,
}

# 全局任务状态追踪
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {} # OCR 任务
_coze_jobs_lock = threading.Lock()
_coze_jobs: dict[str, dict] = {} # Coze 任务


def _json_bytes(obj) -> bytes:
    """将对象转换为 JSON 字节流"""
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _now_ms() -> int:
    """获取当前时间戳（毫秒）"""
    return int(time.time() * 1000)


def _request(method: str, url: str, *, timeout: int, **kwargs) -> requests.Response:
    """带有重试机制的 HTTP 请求工具函数"""
    last_err: Exception | None = None
    for attempt in range(REQUEST_RETRIES):
        try:
            resp = requests.request(method, url, timeout=timeout, **kwargs)
            return resp
        except requests.exceptions.RequestException as e:
            last_err = e
            # 指数退避重试
            sleep_s = min(8, 0.6 * (2**attempt))
            time.sleep(sleep_s)
    if last_err:
        raise last_err
    raise RuntimeError("request failed")


def _coze_auth_headers() -> dict[str, str]:
    """获取 Coze API 的认证头"""
    if not COZE_TOKEN:
        raise RuntimeError("missing COZE_TOKEN")
    return {"Authorization": f"Bearer {COZE_TOKEN}"}


def _coze_run_workflow_sync(user_input: str) -> str:
    """同步调用 Coze 工作流"""
    if not COZE_WORKFLOW_ID:
        raise RuntimeError("missing COZE_WORKFLOW_ID")
    payload = {
        "workflow_id": COZE_WORKFLOW_ID,
        "is_async": True,
        "parameters": {"USER_INPUT": user_input},
    }
    resp = _request(
        "POST",
        COZE_RUN_URL,
        headers={**_coze_auth_headers(), "Content-Type": "application/json"},
        json=payload,
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    code = data.get("code")
    if code != 0:
        raise RuntimeError(data.get("msg") or f"coze error code {code}")
    execute_id = data.get("execute_id") or data.get("executeId")
    if not execute_id:
        raise RuntimeError("missing execute_id")
    return str(execute_id)


def _coze_extract_final_data(history_item: dict) -> str | None:
    """从 Coze 执行历史中提取最终输出数据"""
    output_str = history_item.get("output")
    if not output_str:
        return None
    try:
        output_obj = json.loads(output_str)
    except Exception:
        return None
    inner_output_str = output_obj.get("Output")
    if not inner_output_str:
        return None
    try:
        inner_output_obj = json.loads(inner_output_str)
    except Exception:
        return None
    data = inner_output_obj.get("data")
    if data is None:
        return None
    return str(data)


def _coze_poll_result_sync(execute_id: str, local_job_id: str) -> str:
    """轮询 Coze 工作流的执行结果"""
    if not COZE_WORKFLOW_ID:
        raise RuntimeError("missing COZE_WORKFLOW_ID")
    url = COZE_HISTORY_URL_TEMPLATE.format(
        workflow_id=COZE_WORKFLOW_ID, execute_id=execute_id
    )
    while True:
        resp = _request("GET", url, headers=_coze_auth_headers(), timeout=60)
        resp.raise_for_status()
        body = resp.json()
        data_list = body.get("data") or []
        if not data_list:
            _update_coze_job(local_job_id, {"state": "running"})
            time.sleep(2)
            continue
        item = data_list[0]
        status = item.get("execute_status") or item.get("executeStatus")
        if status:
            _update_coze_job(local_job_id, {"state": status})
        if status == "Success":
            final_data = _coze_extract_final_data(item)
            if final_data is None:
                raise RuntimeError("coze success but missing output data")
            return final_data
        if status in ("Fail", "Failed", "Error"):
            raise RuntimeError("coze failed")
        time.sleep(2)


def _update_coze_job(job_id: str, patch: dict) -> None:
    """更新本地 Coze 任务状态"""
    with _coze_jobs_lock:
        job = _coze_jobs.get(job_id)
        if not job:
            return
        job.update(patch)


def _run_coze(local_job_id: str, user_input: str, output_dir: str | None) -> None:
    """后台运行 Coze 任务的线程函数"""
    try:
        _update_coze_job(local_job_id, {"state": "submitting"})
        execute_id = _coze_run_workflow_sync(user_input)
        _update_coze_job(local_job_id, {"state": "polling", "executeId": execute_id})
        final_data = _coze_poll_result_sync(execute_id, local_job_id)
        saved_path = None
        # 如果提供了输出目录，则保存结果到本地文件
        if output_dir and os.path.isdir(output_dir) and _is_under_output_root(output_dir):
            try:
                split_path = os.path.join(output_dir, "split.txt")
                _write_text(split_path, final_data)
                saved_path = split_path
            except Exception:
                saved_path = None
        _update_coze_job(
            local_job_id,
            {
                "state": "done",
                "result": {"text": final_data},
                "savedPath": saved_path,
                "finishedAt": _now_ms(),
            },
        )
    except Exception as e:
        _update_coze_job(
            local_job_id, {"state": "failed", "error": str(e), "finishedAt": _now_ms()}
        )


def _create_coze_job(user_input: str, output_dir: str | None) -> str:
    """创建一个新的 Coze 任务并启动后台线程"""
    job_id = uuid.uuid4().hex
    with _coze_jobs_lock:
        _coze_jobs[job_id] = {
            "jobId": job_id,
            "state": "created",
            "createdAt": _now_ms(),
            "outputDir": output_dir,
        }
    t = threading.Thread(target=_run_coze, args=(job_id, user_input, output_dir), daemon=True)
    t.start()
    return job_id


def _safe_folder_name(name: str) -> str:
    """将文件名转换为安全的文件夹名称"""
    base = name.strip()
    if not base:
        base = "upload"
    # 替换 Windows 不允许的字符
    base = re.sub(r"[\\/:*?\"<>|]+", "_", base)
    base = re.sub(r"\s+", " ", base).strip()
    if base.endswith("."):
        base = base.rstrip(".")
    if not base:
        base = "upload"
    if len(base) > 120:
        base = base[:120].rstrip()
    return base


def _safe_ffff(microseconds: int) -> int:
    """确保毫秒部分在 0-9999 范围内"""
    if microseconds < 0:
        return 0
    if microseconds > 999999:
        microseconds = 999999
    return microseconds // 100


def _build_img_name(img_ext: str, used_names: set[str]) -> str:
    """根据当前时间生成唯一的图片文件名"""
    current_time = time.time()
    seconds = int(current_time)
    microseconds = int((current_time - seconds) * 1000000)
    base = time.strftime("%Y%m%d%H%M%S", time.localtime(seconds))
    start_ffff = _safe_ffff(microseconds)
    # 尝试寻找不冲突的名称
    for offset in range(10000):
        ffff = (start_ffff + offset) % 10000
        candidate = f"{base}{ffff:04d}{img_ext}"
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
    candidate = f"{base}{start_ffff:04d}{img_ext}"
    used_names.add(candidate)
    return candidate


def _strip_to_text(markdown: str) -> str:
    """将 Markdown 转换为纯文本（移除图片、HTML标签等）"""
    s = markdown
    s = re.sub(r"<img\b[^>]*>", "", s, flags=re.IGNORECASE)
    s = s.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    s = re.sub(r"</?div\b[^>]*>", "\n", s, flags=re.IGNORECASE)
    s = re.sub(r"</?p\b[^>]*>", "\n", s, flags=re.IGNORECASE)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _parse_multipart_file(content_type: str, raw: bytes) -> tuple[str, bytes]:
    """解析 multipart/form-data 格式的上传文件"""
    m = re.search(r"boundary=(?P<b>[^;]+)", content_type, flags=re.IGNORECASE)
    if not m:
        raise ValueError("missing boundary")
    boundary = m.group("b").strip().strip('"')
    if not boundary:
        raise ValueError("missing boundary")
    delimiter = b"--" + boundary.encode("utf-8", errors="ignore")
    for part in raw.split(delimiter):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2].strip(b"\r\n")
        header_blob, sep, body = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        header_text = header_blob.decode("utf-8", errors="replace")
        cd_line = ""
        for line in header_text.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                cd_line = line
                break
        if not cd_line:
            continue
        if 'name="file"' not in cd_line and "name=file" not in cd_line:
            continue
        fm = re.search(r'filename="(?P<fn>[^"]+)"', cd_line)
        filename = fm.group("fn") if fm else "upload"
        if body.endswith(b"\r\n"):
            body = body[:-2]
        return filename, body
    raise ValueError("missing file")


def _write_text(path: str, content: str) -> None:
    """将文本内容写入文件，自动创建目录"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _write_bytes(path: str, content: bytes) -> None:
    """将二进制内容写入文件，自动创建目录"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)


def _is_under_output_root(path: str) -> bool:
    """安全检查：确保路径在 OUTPUT_ROOT 目录下"""
    abs_root = os.path.abspath(OUTPUT_ROOT)
    if not abs_root.endswith(os.path.sep):
        abs_root += os.path.sep
    abs_path = os.path.abspath(path)
    return abs_path.startswith(abs_root)


def _history_scan(limit: int = 200) -> list[dict]:
    """扫描本地输出目录，获取历史 OCR 任务列表"""
    root = OUTPUT_ROOT
    if not os.path.exists(root) or not os.path.isdir(root):
        return []
    items: list[dict] = []
    try:
        folder_names = os.listdir(root)
    except Exception:
        return []
    for folder_name in folder_names:
        folder_dir = os.path.join(root, folder_name)
        if not os.path.isdir(folder_dir):
            continue
        try:
            job_ids = os.listdir(folder_dir)
        except Exception:
            continue
        for job_id in job_ids:
            job_dir = os.path.join(folder_dir, job_id)
            if not os.path.isdir(job_dir):
                continue
            ocr_txt = os.path.join(job_dir, "ocr.txt")
            split_txt = os.path.join(job_dir, "split.txt")
            if not os.path.exists(ocr_txt) or not os.path.isfile(ocr_txt):
                continue
            try:
                # 使用 ocr.txt 的修改时间作为更新时间
                mtime_ms = int(os.path.getmtime(ocr_txt) * 1000)
            except Exception:
                mtime_ms = 0
            items.append(
                {
                    "id": f"{folder_name}/{job_id}",
                    "folderName": folder_name,
                    "jobId": job_id,
                    "hasSplit": os.path.exists(split_txt) and os.path.isfile(split_txt),
                    "updatedAt": mtime_ms,
                }
            )
    # 按时间倒序排序
    items.sort(key=lambda x: x.get("updatedAt") or 0, reverse=True)
    return items[: max(1, int(limit))]


def _submit_job_sync(path: str) -> str:
    """同步提交 OCR 任务（通过 URL 或本地文件路径）"""
    headers = {"Authorization": f"bearer {TOKEN}"}
    if path.startswith("http"):
        headers["Content-Type"] = "application/json"
        payload = {
            "fileUrl": path,
            "model": MODEL,
            "optionalPayload": OPTIONAL_PAYLOAD,
        }
        resp = _request("POST", JOB_URL, json=payload, headers=headers, timeout=300)
    else:
        data = {
            "model": MODEL,
            "optionalPayload": json.dumps(OPTIONAL_PAYLOAD, ensure_ascii=False),
        }
        with open(path, "rb") as f:
            resp = _request(
                "POST", JOB_URL, headers=headers, data=data, files={"file": f}, timeout=300
            )
    resp.raise_for_status()
    return resp.json()["data"]["jobId"]


def _submit_job_bytes_sync(filename: str, content: bytes) -> str:
    """同步提交 OCR 任务（通过上传的二进制数据）"""
    if MAX_UPLOAD_BYTES is not None and len(content) > MAX_UPLOAD_BYTES:
        raise RuntimeError(
            f"upload too large: {len(content)} bytes (max {MAX_UPLOAD_BYTES} bytes). "
            "Please use server-local file path mode instead of browser upload."
        )
    headers = {"Authorization": f"bearer {TOKEN}"}
    data = {
        "model": MODEL,
        "optionalPayload": json.dumps(OPTIONAL_PAYLOAD, ensure_ascii=False),
    }
    files = {"file": (filename, content)}
    resp = _request(
        "POST", JOB_URL, headers=headers, data=data, files=files, timeout=300
    )
    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        if resp.status_code == 413:
            raise RuntimeError(
                "PaddleOCR jobs 接口拒绝上传：文件过大(413)。"
                "建议改用“文件路径”方式（让文件在服务端本机可访问），或改用可被公网访问的 URL 模式。"
            ) from e
        raise
    return resp.json()["data"]["jobId"]


def _poll_job_sync(job_id: str, local_job_id: str) -> str:
    """轮询 OCR 任务的状态，直到完成并获取结果 URL"""
    headers = {"Authorization": f"bearer {TOKEN}"}
    while True:
        resp = _request("GET", f"{JOB_URL}/{job_id}", headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()["data"]
        state = data.get("state")
        if state == "pending":
            _update_job(local_job_id, {"state": "pending"})
        elif state == "running":
            ep = data.get("extractProgress") or {}
            _update_job(
                local_job_id,
                {
                    "state": "running",
                    "progress": {
                        "totalPages": ep.get("totalPages"),
                        "extractedPages": ep.get("extractedPages"),
                    },
                },
            )
        elif state == "failed":
            raise RuntimeError(data.get("errorMsg") or "failed")
        elif state == "done":
            json_url = (data.get("resultUrl") or {}).get("jsonUrl")
            if not json_url:
                raise RuntimeError("missing jsonUrl")
            return json_url
        time.sleep(2)


def _process_and_save_jsonl(
    jsonl_text: str, base_dir: str, base_name: str, folder_name: str, local_job_id: str
) -> dict:
    """处理并保存 OCR 结果（JSONL格式），下载图片并替换路径"""
    output_dir = os.path.join(base_dir, "output")
    imgs_dir = os.path.join(output_dir, "imgs")
    os.makedirs(imgs_dir, exist_ok=True)

    all_md: list[str] = []
    all_txt: list[str] = []
    used_img_names: set[str] = set()
    page_num = 0

    for line in jsonl_text.splitlines():
        line = line.strip()
        if not line:
            continue
        result = json.loads(line)["result"]
        for res in result.get("layoutParsingResults") or []:
            original_md_content = res["markdown"]["text"]
            md_replace_map: dict[str, str] = {}
            txt_replace_map: dict[str, str] = {}

            # 处理 Markdown 中的图片
            for img_path, img_url in (res["markdown"].get("images") or {}).items():
                img_ext = os.path.splitext(img_path)[1].lower() or ".jpg"
                new_img_name = _build_img_name(img_ext, used_img_names)
                full_img_path = os.path.join(imgs_dir, new_img_name)
                try:
                    # 下载远程图片到本地
                    img_resp = _request("GET", img_url, timeout=60)
                    img_resp.raise_for_status()
                    _write_bytes(full_img_path, img_resp.content)
                    rel_img_path = f"{folder_name}/{local_job_id}/output/imgs/{new_img_name}"
                    md_replace_map[img_path] = f"output/imgs/{new_img_name}"
                    txt_replace_map[img_path] = rel_img_path
                except Exception:
                    # 下载失败则保留原始 URL
                    md_replace_map[img_path] = img_url
                    txt_replace_map[img_path] = img_url

            # 替换 Markdown 中的图片路径
            md_replaced = original_md_content
            for orig_path, repl in md_replace_map.items():
                md_replaced = md_replaced.replace(orig_path, repl)
            all_md.append(md_replaced)

            # 保存单页 Markdown
            md_filename = os.path.join(base_dir, f"{base_name}_{page_num}.md")
            _write_text(md_filename, md_replaced)

            # 替换 TXT 版本中的路径（用于前端显示）
            txt_replaced = original_md_content
            for orig_path, repl in txt_replace_map.items():
                txt_replaced = txt_replaced.replace(orig_path, repl)
            all_txt.append(txt_replaced)

            # 保存单页 TXT
            txt_filename = os.path.join(base_dir, f"{base_name}_{page_num}.txt")
            _write_text(txt_filename, txt_replaced)

            page_num += 1

    # 合并所有页面
    merged_md = "\n\n".join(all_md)
    merged_txt = "\n\n".join(all_txt)
    _write_text(os.path.join(base_dir, "ocr.md"), merged_md)
    _write_text(os.path.join(base_dir, "ocr.txt"), merged_txt)

    return {"pages": page_num, "markdown": merged_md, "txt": merged_txt}


def _run_ocr(local_job_id: str, path: str | None, uploaded: tuple[str, bytes] | None) -> None:
    """后台运行 OCR 任务的线程主逻辑"""
    try:
        _update_job(local_job_id, {"state": "submitting"})
        # 1. 提交任务
        if uploaded is not None:
            filename, content = uploaded
            remote_job_id = _submit_job_bytes_sync(filename, content)
        else:
            remote_job_id = _submit_job_sync(path or "")
        
        # 2. 轮询状态
        _update_job(local_job_id, {"state": "polling", "remoteJobId": remote_job_id})
        json_url = _poll_job_sync(remote_job_id, local_job_id)
        
        # 3. 下载结果
        _update_job(local_job_id, {"state": "downloading", "jsonUrl": json_url})
        jsonl_resp = _request("GET", json_url, timeout=300)
        jsonl_resp.raise_for_status()
        
        # 4. 准备本地保存目录
        folder_name = ""
        if uploaded is not None:
            folder_name = _safe_folder_name(os.path.basename(uploaded[0]))
        elif path:
            folder_name = _safe_folder_name(os.path.basename(path))
        else:
            folder_name = _safe_folder_name("job")

        base_dir = os.path.join(OUTPUT_ROOT, folder_name, local_job_id)
        os.makedirs(base_dir, exist_ok=True)
        base_name = os.path.splitext(folder_name)[0] or folder_name

        # 尝试备份原始上传文件
        try:
            if uploaded is not None:
                up_name = os.path.basename(uploaded[0]) or "upload.bin"
                _write_bytes(os.path.join(base_dir, up_name), uploaded[1])
            elif path and not path.startswith("http") and os.path.exists(path):
                try:
                    with open(path, "rb") as rf:
                        _write_bytes(os.path.join(base_dir, os.path.basename(path)), rf.read())
                except Exception:
                    pass
        except Exception:
            pass

        # 5. 处理并保存最终结果
        _update_job(local_job_id, {"state": "saving", "outputDir": base_dir})
        saved = _process_and_save_jsonl(
            jsonl_resp.text,
            base_dir=base_dir,
            base_name=base_name,
            folder_name=folder_name,
            local_job_id=local_job_id,
        )
        
        # 6. 更新任务为完成
        _update_job(
            local_job_id,
            {
                "state": "done",
                "result": {
                    "text": saved["txt"],
                    "pages": saved["pages"],
                    "outputDir": base_dir,
                },
                "finishedAt": _now_ms(),
            },
        )
    except Exception as e:
        _update_job(
            local_job_id,
            {"state": "failed", "error": str(e), "finishedAt": _now_ms()},
        )


def _update_job(job_id: str, patch: dict) -> None:
    """更新本地 OCR 任务状态"""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(patch)


def _create_job(path: str) -> str:
    """创建一个基于路径/URL的 OCR 任务"""
    local_job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[local_job_id] = {
            "jobId": local_job_id,
            "state": "created",
            "createdAt": _now_ms(),
            "path": path,
        }
    t = threading.Thread(target=_run_ocr, args=(local_job_id, path, None), daemon=True)
    t.start()
    return local_job_id


def _create_job_upload(filename: str, content: bytes) -> str:
    """创建一个基于上传二进制数据的 OCR 任务"""
    local_job_id = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[local_job_id] = {
            "jobId": local_job_id,
            "state": "created",
            "createdAt": _now_ms(),
            "path": None,
            "fileName": filename,
            "fileSize": len(content),
        }
    t = threading.Thread(
        target=_run_ocr, args=(local_job_id, None, (filename, content)), daemon=True
    )
    t.start()
    return local_job_id


class Handler(BaseHTTPRequestHandler):
    """自定义 HTTP 请求处理器"""
    protocol_version = "HTTP/1.1"

    def _send_file(self, file_path: str):
        """发送本地静态文件"""
        file_path = os.path.normpath(file_path)
        
        if not os.path.exists(file_path) or not os.path.isfile(file_path):
            print(f"404: File not found on disk: {file_path}")
            self._send(404, _json_bytes({"error": f"file_not_found: {file_path}"}))
            return
        
        # 安全检查
        abs_file = os.path.abspath(file_path).lower()
        abs_root = os.path.abspath(OUTPUT_ROOT).lower()
        if not abs_root.endswith(os.path.sep):
            abs_root += os.path.sep
        if not abs_file.startswith(abs_root):
            print(f"403: Security check failed for: {abs_file} (Root: {abs_root})")
            self._send(403, _json_bytes({"error": "forbidden"}))
            return

        ctype, _ = mimetypes.guess_type(file_path)
        if not ctype:
            ctype = "application/octet-stream"
        
        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self._send(500, _json_bytes({"error": str(e)}))

    def _send(self, status: int, body: bytes, content_type: str = "application/json"):
        """发送 JSON 响应"""
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_OPTIONS(self):
        """处理 CORS 预检请求"""
        self._send(204, b"", "text/plain")

    def do_GET(self):
        """处理 GET 请求"""
        try:
            parsed = urlparse(self.path)
            # 服务输出目录下的静态文件
            if parsed.path.startswith("/output/"):
                relative_path = unquote(self.path.split("/output/", 1)[1])
                full_path = os.path.join(OUTPUT_ROOT, relative_path)
                self._send_file(full_path)
                return

            # 健康检查
            if parsed.path == "/health":
                self._send(200, _json_bytes({"ok": True}))
                return

            # 获取历史任务列表
            if parsed.path == "/api/history":
                qs = parse_qs(parsed.query or "")
                limit_raw = (qs.get("limit") or [None])[0]
                try:
                    limit = int(limit_raw) if limit_raw else 200
                except Exception:
                    limit = 200
                items = _history_scan(limit=limit)
                self._send(200, _json_bytes({"items": items}))
                return

            # 获取某个任务关联的所有素材（图片、PDF）
            if parsed.path == "/api/history/assets":
                qs = parse_qs(parsed.query or "")
                item_id = (qs.get("id") or [""])[0].strip()
                if not item_id or ".." in item_id or item_id.startswith(("/", "\\")):
                    self._send(400, _json_bytes({"error": "bad_id"}))
                    return
                parts = [p for p in item_id.split("/") if p]
                if len(parts) < 2:
                    self._send(400, _json_bytes({"error": "bad_id"}))
                    return
                folder_name = parts[0]
                job_id = parts[1]
                job_dir = os.path.join(OUTPUT_ROOT, folder_name, job_id)
                if not os.path.isdir(job_dir) or not _is_under_output_root(job_dir):
                    self._send(404, _json_bytes({"error": "not_found"}))
                    return
                allow_exts = {".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}
                files = []
                try:
                    for name in os.listdir(job_dir):
                        _, ext = os.path.splitext(name)
                        if ext.lower() in allow_exts:
                            fpath = os.path.join(job_dir, name)
                            if os.path.isfile(fpath):
                                url_path = f"output/{folder_name}/{job_id}/{name}"
                                ftype = "pdf" if ext.lower() == ".pdf" else "image"
                                files.append({"name": name, "url": url_path, "type": ftype})
                except Exception:
                    pass
                self._send(200, _json_bytes({"files": files}))
                return

            # 获取具体历史任务的内容
            if parsed.path == "/api/history/item":
                qs = parse_qs(parsed.query or "")
                item_id = (qs.get("id") or [""])[0].strip()
                req_type = (qs.get("type") or [""])[0].strip().lower()
                if not item_id or ".." in item_id or item_id.startswith(("/", "\\")):
                    self._send(400, _json_bytes({"error": "bad_id"}))
                    return
                parts = [p for p in item_id.split("/") if p]
                if len(parts) < 2:
                    self._send(400, _json_bytes({"error": "bad_id"}))
                    return
                folder_name = parts[0]
                job_id = parts[1]
                job_dir = os.path.join(OUTPUT_ROOT, folder_name, job_id)
                if not os.path.isdir(job_dir) or not _is_under_output_root(job_dir):
                    self._send(404, _json_bytes({"error": "not_found"}))
                    return
                ocr_txt = os.path.join(job_dir, "ocr.txt")
                split_txt = os.path.join(job_dir, "split.txt")
                target = ocr_txt if req_type != "split" else split_txt
                if not os.path.exists(target) or not os.path.isfile(target):
                    self._send(404, _json_bytes({"error": "not_found"}))
                    return
                try:
                    with open(target, "r", encoding="utf-8") as f:
                        text = f.read()
                except Exception as e:
                    self._send(500, _json_bytes({"error": str(e)}))
                    return
                self._send(
                    200,
                    _json_bytes(
                        {
                            "id": f"{folder_name}/{job_id}",
                            "folderName": folder_name,
                            "jobId": job_id,
                            "outputDir": job_dir,
                            "type": "split" if req_type == "split" else "ocr",
                            "text": text,
                        }
                    ),
                )
                return

            # 查询 Coze 任务状态
            if parsed.path.startswith("/api/coze/"):
                job_id = parsed.path.split("/api/coze/", 1)[1].strip("/")
                with _coze_jobs_lock:
                    job = _coze_jobs.get(job_id)
                if not job:
                    self._send(404, _json_bytes({"error": "not_found"}))
                    return
                payload = {
                    "jobId": job["jobId"],
                    "state": job.get("state"),
                    "error": job.get("error"),
                    "createdAt": job.get("createdAt"),
                    "finishedAt": job.get("finishedAt"),
                    "result": job.get("result") if job.get("state") == "done" else None,
                }
                self._send(200, _json_bytes(payload))
                return
            
            # 查询 OCR 任务状态
            if parsed.path.startswith("/api/ocr/"):
                job_id = parsed.path.split("/api/ocr/", 1)[1].strip("/")
                with _jobs_lock:
                    job = _jobs.get(job_id)
                if not job:
                    self._send(404, _json_bytes({"error": "not_found"}))
                    return
                payload = {
                    "jobId": job["jobId"],
                    "state": job.get("state"),
                    "progress": job.get("progress"),
                    "error": job.get("error"),
                    "createdAt": job.get("createdAt"),
                    "finishedAt": job.get("finishedAt"),
                    "result": job.get("result") if job.get("state") == "done" else None,
                }
                self._send(200, _json_bytes(payload))
                return
            self._send(404, _json_bytes({"error": "not_found"}))
        except Exception as e:
            self._send(500, _json_bytes({"error": str(e)}))

    def do_POST(self):
        """处理 POST 请求"""
        try:
            parsed = urlparse(self.path)
            # 运行 Coze 工作流
            if parsed.path == "/api/coze/run":
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length > 0 else b"{}"
                try:
                    data = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send(400, _json_bytes({"error": "bad_json"}))
                    return
                subject = (data.get("subject") or "").strip()
                text = (data.get("text") or "").strip()
                output_dir = (data.get("outputDir") or "").strip() or None
                if output_dir and (not os.path.isdir(output_dir) or not _is_under_output_root(output_dir)):
                    output_dir = None
                if not subject:
                    self._send(400, _json_bytes({"error": "missing_subject"}))
                    return
                if not text:
                    self._send(400, _json_bytes({"error": "missing_text"}))
                    return
                user_input = subject + "\n" + text
                job_id = _create_coze_job(user_input, output_dir)
                self._send(200, _json_bytes({"jobId": job_id}))
                return
            
            # 上传文件并识别
            if parsed.path == "/api/ocr/upload":
                content_type = self.headers.get("Content-Type") or ""
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length > 0 else b""
                filename, content = _parse_multipart_file(content_type, raw)
                job_id = _create_job_upload(filename, content)
                self._send(200, _json_bytes({"jobId": job_id}))
                return
            
            # 根据路径/URL识别
            if parsed.path != "/api/ocr":
                self._send(404, _json_bytes({"error": "not_found"}))
                return
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                self._send(400, _json_bytes({"error": "bad_json"}))
                return
            path = (data.get("path") or "").strip()
            if not path:
                self._send(400, _json_bytes({"error": "missing_path"}))
                return
            if not path.startswith("http") and (
                not os.path.exists(path) or not os.path.isfile(path)
            ):
                self._send(400, _json_bytes({"error": "file_not_found"}))
                return
            job_id = _create_job(path)
            self._send(200, _json_bytes({"jobId": job_id}))
        except Exception as e:
            self._send(500, _json_bytes({"error": str(e)}))


def main():
    """程序入口：启动多线程 HTTP 服务器"""
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"API listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
