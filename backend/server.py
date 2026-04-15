import json
import os
import re
import threading
import time
import uuid
import mimetypes
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, unquote

import requests
from PIL import Image

# 服务器配置
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8000"))

# OCR 并发配置
MAX_CONCURRENT_OCR = int(os.environ.get("MAX_CONCURRENT_OCR") or "5")

# MinerU API 配置
MINERU_API_BASE = "https://mineru.net"
MINERU_MODEL = "vlm"
TOKEN = os.environ.get("MINERU_TOKEN") or "eyJ0eXBlIjoiSldUIiwiYWxnIjoiSFM1MTIifQ.eyJqdGkiOiIzNjUwMDcyOSIsInJvbCI6IlJPTEVfUkVHSVNURVIiLCJpc3MiOiJPcGVuWExhYiIsImlhdCI6MTc3NjIxNDQ4MywiY2xpZW50SWQiOiJsa3pkeDU3bnZ5MjJqa3BxOXgydyIsInBob25lIjoiIiwib3BlbklkIjpudWxsLCJ1dWlkIjoiZmFkODY3NzAtYmMyZC00YWMwLWFjZDUtYmUxN2ZlOGIwMTdkIiwiZW1haWwiOiIiLCJleHAiOjE3ODM5OTA0ODN9.8jipIByG4mmmMwlG5-t5CuH6jpLQHc1qOp1C_eqwFkPjv8pR4_7idy1jn3UB4B7q1-zEFDlMfbW0REKJSMad9g"
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

# 参考答案文件夹名称列表
ANSWER_FOLDER_NAMES = ["参考答案", "答案", "answer", "Answer", "ANSWER", "答案解析"]

# 全局任务状态追踪
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {} # OCR 任务
_coze_jobs_lock = threading.Lock()
_coze_jobs: dict[str, dict] = {} # Coze 任务

class RateLimiter:
    """限流器：基于滑动窗口的请求速率限制"""
    def __init__(self, max_requests: int, period: float):
        self.max_requests = max_requests
        self.period = period
        self.timestamps = []
        self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            now = time.time()
            # 移除在时间窗口之外的请求记录
            self.timestamps = [t for t in self.timestamps if now - t < self.period]
            if len(self.timestamps) >= self.max_requests:
                # 需要等待直到最早的请求超出时间窗口
                sleep_time = self.period - (now - self.timestamps[0])
                if sleep_time > 0:
                    time.sleep(sleep_time)
                now = time.time()
                # 重新过滤（因为等待后可能有更多的请求过期）
                self.timestamps = [t for t in self.timestamps if now - t < self.period]
            self.timestamps.append(now)

# 接口限流配置 (根据 MinerU 官网限流策略)
# 提交任务接口：300 次/分钟
submit_rate_limiter = RateLimiter(300, 60.0)
# 获取任务结果接口：1000 次/分钟
poll_rate_limiter = RateLimiter(1000, 60.0)


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
    print(f"[COZE] has_answer={has_answer}, payload={json.dumps(payload, ensure_ascii=False)[:500]}...")
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


def _run_coze(local_job_id: str, user_input: str, output_dir: str | None, has_answer: bool = False, subject: str = "") -> None:
    """后台运行 Coze 任务的线程函数"""
    try:
        _update_coze_job(local_job_id, {"state": "submitting"})
        execute_id = _coze_run_workflow_sync(user_input, subject, has_answer)
        _update_coze_job(local_job_id, {"state": "polling", "executeId": execute_id})
        final_data = _coze_poll_result_sync(execute_id, local_job_id)
        saved_path = None
        # 如果提供了输出目录，则保存结果到本地文件
        print(f"[COZE] output_dir={output_dir}, is_dir={os.path.isdir(output_dir) if output_dir else False}")
        if output_dir and os.path.isdir(output_dir) and _is_under_output_root(output_dir):
            try:
                split_path = os.path.join(output_dir, "split.txt")
                _write_text(split_path, final_data)
                saved_path = split_path
                print(f"[COZE] 保存分割结果到: {split_path}")
            except Exception as e:
                print(f"[COZE] 保存失败: {e}")
                saved_path = None
        _update_coze_job(
            local_job_id,
            {
                "state": "done",
                "result": {"text": final_data},
                "savedPath": saved_path,
                "hasAnswer": has_answer,
                "finishedAt": _now_ms(),
            },
        )
    except Exception as e:
        _update_coze_job(
            local_job_id, {"state": "failed", "error": str(e), "finishedAt": _now_ms()}
        )


def _create_coze_job(user_input: str, output_dir: str | None, has_answer: bool = False, subject: str = "") -> str:
    """创建一个新的 Coze 任务并启动后台线程"""
    job_id = uuid.uuid4().hex
    with _coze_jobs_lock:
        _coze_jobs[job_id] = {
            "jobId": job_id,
            "state": "created",
            "createdAt": _now_ms(),
            "outputDir": output_dir,
            "hasAnswer": has_answer,
            "subject": subject,
        }
    t = threading.Thread(target=_run_coze, args=(job_id, user_input, output_dir, has_answer, subject), daemon=True)
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
            
            # 读取 hasAnswer
            has_answer = False
            try:
                meta_file = os.path.join(job_dir, "meta.json")
                if os.path.exists(meta_file):
                    with open(meta_file, "r", encoding="utf-8") as f:
                        meta_data = json.load(f)
                        has_answer = meta_data.get("hasAnswer", False)
                else:
                    # 兼容旧数据：检查参考答案目录
                    answer_dir = os.path.join(job_dir, "参考答案")
                    has_answer = os.path.isdir(answer_dir)
            except Exception:
                pass
            
            items.append(
                {
                    "id": f"{folder_name}/{job_id}",
                    "folderName": folder_name,
                    "jobId": job_id,
                    "hasSplit": os.path.exists(split_txt) and os.path.isfile(split_txt),
                    "hasAnswer": has_answer,
                    "updatedAt": mtime_ms,
                }
            )
    # 按时间倒序排序
    items.sort(key=lambda x: x.get("updatedAt") or 0, reverse=True)
    return items[: max(1, int(limit))]


def _is_answer_folder(name: str) -> bool:
    """检查文件夹名称是否为参考答案文件夹"""
    return name in ANSWER_FOLDER_NAMES


def _get_all_images_from_folder(folder_path: str) -> list[str]:
    """获取文件夹下所有 jpg 图片，按文件名自然排序"""
    images = []
    image_extensions = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
    try:
        for fname in os.listdir(folder_path):
            ext = os.path.splitext(fname)[1].lower()
            if ext in image_extensions:
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    images.append(fpath)
    except Exception:
        pass
    # 按文件名排序
    return sorted(images, key=os.path.basename)


def _get_answer_folder(folder_path: str) -> str | None:
    """获取参考答案文件夹路径"""
    for name in ANSWER_FOLDER_NAMES:
        answer_path = os.path.join(folder_path, name)
        if os.path.isdir(answer_path):
            return answer_path
    return None


def _extract_page_from_filename(filename: str) -> str:
    """从文件名中提取页面信息，格式如 p_页面_015.095950.jpg"""
    basename = os.path.splitext(filename)[0]
    return basename


def _submit_job_sync(path: str, is_folder: bool = False, token: str | None = None, language: str = "zh") -> str:
    """同步提交 OCR 任务（通过本地文件路径）"""
    if path.startswith("http"):
        raise RuntimeError("HTTP URLs are temporarily not supported. Please upload files directly.")
    with open(path, "rb") as f:
        content = f.read()
    return _submit_job_bytes_sync(os.path.basename(path), content, token, language)


def _submit_job_bytes_sync(filename: str, content: bytes, token: str | None = None, language: str = "zh") -> str:
    """同步提交 OCR 任务（通过上传的二进制数据）"""
    if MAX_UPLOAD_BYTES is not None and len(content) > MAX_UPLOAD_BYTES:
        raise RuntimeError(
            f"upload too large: {len(content)} bytes (max {MAX_UPLOAD_BYTES} bytes)."
        )
    auth_token = token or TOKEN
    if not auth_token:
        raise RuntimeError("MinerU Token is missing. Please provide it in the UI or set MINERU_TOKEN.")
    headers = {
        "Authorization": f"Bearer {auth_token}",
        "Content-Type": "application/json"
    }
    
    # 1. Get presigned URL
    payload = {
        "language": language,
        "files": [{"name": filename, "is_ocr": True}],
        "model_version": MINERU_MODEL,
    }
    
    # 应用提交流程的限流 (300次/分钟)
    submit_rate_limiter.wait()
    
    resp = _request("POST", f"{MINERU_API_BASE}/api/v4/file-urls/batch", json=payload, headers=headers, timeout=60)
    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        raise RuntimeError(f"MinerU API Error: {resp.text}") from e
        
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"MinerU error: {data.get('msg')}")
        
    batch_id = data["data"]["batch_id"]
    file_urls = data["data"]["file_urls"]
    if not file_urls:
        raise RuntimeError("MinerU returned no file URLs")
    file_url = file_urls[0]

    # 2. Upload file content to presigned URL
    upload_resp = _request("PUT", file_url, data=content, timeout=300)
    upload_resp.raise_for_status()

    return batch_id


def _poll_job_sync(job_id: str, local_job_id: str, token: str | None = None) -> str:
    """轮询 OCR 任务的状态，直到完成并获取结果 ZIP URL"""
    auth_token = token or TOKEN
    headers = {"Authorization": f"Bearer {auth_token}"}
    
    while True:
        # 应用轮询流程的限流 (1000次/分钟)
        poll_rate_limiter.wait()
        
        resp = _request("GET", f"{MINERU_API_BASE}/api/v4/extract-results/batch/{job_id}", headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        
        if data.get("code") != 0:
            raise RuntimeError(f"MinerU error: {data.get('msg')}")
            
        extract_results = data.get("data", {}).get("extract_result", [])
        if not extract_results:
            _update_job(local_job_id, {"state": "pending"})
            time.sleep(2)
            continue
            
        task = extract_results[0]
        state = task.get("state")
        
        if state in ("processing", "pending", "converting"):
            _update_job(local_job_id, {"state": "running"})
        elif state == "failed":
            raise RuntimeError(task.get("error_msg") or "MinerU task failed")
        elif state == "done":
            zip_url = task.get("full_zip_url")
            if not zip_url:
                raise RuntimeError("MinerU missing full_zip_url in done state")
            return zip_url
            
        time.sleep(5)


def _process_mineru_zip(
    zip_bytes: bytes, base_dir: str, base_name: str, folder_name: str, local_job_id: str,
    img_name: str | None = None, page_index: int = 0
) -> dict:
    """处理并保存 MinerU 返回的 ZIP 结果"""
    import zipfile
    import io
    
    txt_base_dir = os.path.join(base_dir, "txt")
    os.makedirs(txt_base_dir, exist_ok=True)
    
    output_imgs_dir = os.path.join(base_dir, "output", "imgs")
    os.makedirs(output_imgs_dir, exist_ok=True)
    
    md_content = ""
    
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        # 首先提取图片
        for filename in z.namelist():
            if filename.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff')):
                # MinerU 的 zip 里图片通常在 images 文件夹下
                # 我们把它们提取到 output_imgs_dir，并保持原名
                img_basename = os.path.basename(filename)
                if not img_basename:
                    continue
                img_data = z.read(filename)
                _write_bytes(os.path.join(output_imgs_dir, img_basename), img_data)
                
        # 提取 Markdown 和 JSON
        for filename in z.namelist():
            if filename.endswith(".md"):
                md_content = z.read(filename).decode("utf-8")
            elif filename.endswith(".json"):
                # 可以保存原始 json，用于前端可能需要的调试或标记
                json_data = z.read(filename)
                if img_name:
                    res_file_path = os.path.join(txt_base_dir, f"res_{img_name}.txt")
                    _write_bytes(res_file_path, json_data)

    # 替换 Markdown 中的图片路径
    # MinerU 的 markdown 图片路径一般是 "images/xxx.jpg" 或 "./images/xxx.jpg"
    # 我们需要将其替换为前端可以访问的相对路径
    # 使用正则表达式替换图片路径
    import re
    def replacer(match):
        img_path = match.group(1)
        img_basename = os.path.basename(img_path)
        # 前端请求时，会加上 API_BASE/output/folder_name/local_job_id/output/imgs/...
        # 所以在 markdown 里，我们存 output/imgs/xxx.jpg
        return f"output/imgs/{img_basename}"

    md_replaced = re.sub(r'!\[.*?\]\(([^)]+)\)', lambda m: f"![image]({replacer(m)})", md_content)
    
    # 因为 MinerU 的 Markdown 包含格式，这里 txt 也直接使用 markdown
    txt_replaced = md_replaced

    # 保存单页 Markdown/TXT
    page_num = page_index
    md_filename = os.path.join(txt_base_dir, f"{base_name}_{page_num}.md")
    _write_text(md_filename, md_replaced)
    
    txt_filename = os.path.join(txt_base_dir, f"{base_name}_{page_num}.txt")
    _write_text(txt_filename, txt_replaced)

    return {"pages": 1, "markdown_parts": [md_replaced], "txt_parts": [txt_replaced]}


def _process_single_image(img_path: str, base_dir: str, folder_name: str, local_job_id: str, token: str | None = None, language: str = "zh") -> dict | None:
    """处理单张图片，返回结果或None（失败时）"""
    img_basename = os.path.basename(img_path)
    try:
        # 提交 OCR 任务
        remote_job_id = _submit_job_sync(img_path, token=token, language=language)
        
        # 轮询状态
        zip_url = _poll_job_sync(remote_job_id, local_job_id, token=token)
        
        # 下载结果
        zip_resp = _request("GET", zip_url, timeout=300)
        zip_resp.raise_for_status()
        
        # 处理并保存（使用图片名称作为文件名，避免覆盖）
        base_name = os.path.splitext(img_basename)[0]
        saved = _process_mineru_zip(
            zip_resp.content,
            base_dir=base_dir,
            base_name=base_name,
            folder_name=folder_name,
            local_job_id=local_job_id,
            img_name=img_basename,
            page_index=0  # 每个图片独立保存，page_index从0开始
        )
        
        return {
            "success": True,
            "img_basename": img_basename,
            "img_path": img_path,
            "markdown_parts": saved["markdown_parts"],
            "txt_parts": saved["txt_parts"],
            "pages": saved["pages"]
        }
    except Exception as e:
        return {
            "success": False,
            "img_basename": img_basename,
            "error": str(e)
        }


def _process_folder_sync(folder_path: str, base_dir: str, folder_name: str, local_job_id: str, token: str | None = None) -> dict:
    """处理文件夹中的所有图片（并发），返回合并后的文本"""
    all_md: list[str] = []
    all_txt: list[str] = []
    total_pages = 0
    has_answer = False
    failed_count = 0

    # 获取所有图片
    images = _get_all_images_from_folder(folder_path)
    total_images = len(images)

    # 创建目录结构
    # - imgs/ : 原图片
    # - pdfs/ : PDF文件
    # - txt/ : 识别的txt文件
    # - 参考答案/ : 参考答案目录（内含imgs、txt、pdfs）
    imgs_dir = os.path.join(base_dir, "imgs")
    pdf_dir = os.path.join(base_dir, "pdfs")
    txt_dir = os.path.join(base_dir, "txt")
    os.makedirs(imgs_dir, exist_ok=True)
    os.makedirs(pdf_dir, exist_ok=True)
    os.makedirs(txt_dir, exist_ok=True)

    # 复制原图片
    for img_path in images:
        img_basename = os.path.basename(img_path)
        try:
            dest_path = os.path.join(imgs_dir, img_basename)
            if not os.path.exists(dest_path):
                with open(img_path, "rb") as src:
                    _write_bytes(dest_path, src.read())
        except Exception as e:
            log(f"复制原图片 {img_basename} 失败: {e}")

    # 复制 PDF 文件
    _copy_pdfs_from_folder(folder_path, pdf_dir)

    if total_images == 0:
        raise RuntimeError(f"文件夹中没有找到图片: {folder_path}")

    log_msg = f"找到 {total_images} 张图片，开始并发处理（最大 {MAX_CONCURRENT_OCR} 并发）"
    _update_job(local_job_id, {"log": log_msg})

    with _jobs_lock:
        job = _jobs.get(local_job_id, {})
    language = job.get("language", "zh")

    # 使用 ThreadPoolExecutor 并发处理
    processed_results = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_OCR) as executor:
        # 提交所有任务
        future_to_img = {
            executor.submit(_process_single_image, img_path, base_dir, folder_name, local_job_id, token=token, language=language): img_path
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
    # 先按文件名排序以获得正确的顺序
    sorted_images = sorted(images, key=os.path.basename)
    image_order = {os.path.basename(p): i for i, p in enumerate(sorted_images)}
    processed_results.sort(key=lambda x: image_order.get(x["img_basename"], 999))

    # 组装正文文本（按顺序）
    for result in processed_results:
        all_md.extend(result["markdown_parts"])
        all_txt.extend(result["txt_parts"])
        total_pages += result["pages"]

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
                executor.submit(_process_single_image, img_path, os.path.join(base_dir, "参考答案"), folder_name, local_job_id, token=token, language=language): img_path
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

    # 合并所有页面并保存
    log_msg = "开始合并保存最终文本..."
    _update_job(local_job_id, {"log": log_msg})
    merged_md = "\n\n".join(all_md)
    merged_txt = "\n\n".join(all_txt)
    _write_text(os.path.join(base_dir, "ocr.md"), merged_md)
    _write_text(os.path.join(base_dir, "ocr.txt"), merged_txt)
    
    # 保存元数据文件（包含 hasAnswer）
    import json
    meta_file = os.path.join(base_dir, "meta.json")
    meta_data = {
        "hasAnswer": has_answer,
        "pages": total_pages,
        "failedCount": failed_count,
        "finishedAt": _now_ms(),
    }
    _write_text(meta_file, json.dumps(meta_data, ensure_ascii=False, indent=2))

    # 后台生成合并PDF（不阻塞完成通知）
    def generate_merged_pdf_async():
        try:
            _ensure_merged_pdf(base_dir, safe_folder_name, local_job_id)
        except Exception as e:
            print(f"[PDF] 后台生成合并PDF失败: {e}")
    threading.Thread(target=generate_merged_pdf_async, daemon=True).start()

    log_msg = f"处理完成：{len(images)} 张正文图片，{failed_count} 张失败"
    _update_job(local_job_id, {"log": log_msg})

    return {
        "pages": total_pages,
        "markdown": merged_md,
        "txt": merged_txt,
        "hasAnswer": has_answer,
        "failedCount": failed_count
    }


def _copy_pdfs_from_folder(folder_path: str, dest_dir: str) -> list[str]:
    """复制文件夹中的所有 PDF 到目标目录"""
    copied = []
    try:
        for fname in os.listdir(folder_path):
            fpath = os.path.join(folder_path, fname)
            if os.path.isfile(fpath) and fname.lower().endswith(".pdf"):
                dest_path = os.path.join(dest_dir, fname)
                try:
                    with open(fpath, "rb") as src:
                        _write_bytes(dest_path, src.read())
                    copied.append(fname)
                except Exception:
                    pass
    except Exception:
        pass
    return copied


def _merge_images_to_pdf(image_paths: list[str], output_pdf_path: str) -> bool:
    """将多张图片合并为一个PDF文件（按顺序）

    Args:
        image_paths: 图片路径列表（按正确顺序排列）
        output_pdf_path: 输出的PDF文件路径

    Returns:
        是否成功
    """
    if not image_paths:
        return False

    try:
        images = []
        for img_path in image_paths:
            try:
                # 打开图片并转换为RGB模式（确保兼容PDF）
                img = Image.open(img_path)
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                images.append(img)
            except Exception as e:
                print(f"[PDF] 无法打开图片 {img_path}: {e}")
                continue

        if not images:
            return False

        # 保存为PDF（第一个图片作为封面）
        images[0].save(
            output_pdf_path,
            save_all=True,
            append_images=images[1:] if len(images) > 1 else [],
            resolution=100.0
        )
        print(f"[PDF] 合并完成: {output_pdf_path} ({len(images)} 页)")
        return True
    except Exception as e:
        print(f"[PDF] 合并失败: {e}")
        return False


def _get_merged_pdf_path(job_dir: str, folder_name: str, job_id: str) -> str:
    """获取合并PDF的路径（缓存路径）"""
    return os.path.join(job_dir, "merged.pdf")


def _ensure_merged_pdf(job_dir: str, folder_name: str, job_id: str) -> str | None:
    """确保合并PDF存在，如果不存在则创建

    Returns:
        合并PDF的URL路径，如果失败返回None
    """
    merged_pdf_path = _get_merged_pdf_path(job_dir, folder_name, job_id)

    # 如果已存在，直接返回
    if os.path.exists(merged_pdf_path):
        return f"output/{folder_name}/{job_id}/merged.pdf"

    # 获取 imgs 目录下的所有图片（按文件名排序，与文本顺序一致）
    imgs_dir = os.path.join(job_dir, "imgs")
    if not os.path.isdir(imgs_dir):
        print(f"[PDF] imgs目录不存在: {imgs_dir}")
        return None

    image_paths = []
    try:
        for fname in sorted(os.listdir(imgs_dir)):
            ext = os.path.splitext(fname)[1].lower()
            if ext in {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}:
                image_paths.append(os.path.join(imgs_dir, fname))
    except Exception as e:
        print(f"[PDF] 读取imgs目录失败: {e}")
        return None

    # 获取参考答案目录下的图片并追加
    answer_imgs_dir = os.path.join(job_dir, "参考答案", "imgs")
    if os.path.isdir(answer_imgs_dir):
        try:
            for fname in sorted(os.listdir(answer_imgs_dir)):
                ext = os.path.splitext(fname)[1].lower()
                if ext in {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}:
                    image_paths.append(os.path.join(answer_imgs_dir, fname))
        except Exception as e:
            print(f"[PDF] 读取参考答案imgs目录失败: {e}")

    if not image_paths:
        print(f"[PDF] 没有找到图片: {imgs_dir}")
        return None

    # 合并图片为PDF
    if _merge_images_to_pdf(image_paths, merged_pdf_path):
        return f"output/{folder_name}/{job_id}/merged.pdf"

    return None


def _parse_multipart_folder_upload(content_type: str, raw: bytes) -> tuple[str, dict[str, bytes]]:
    """解析 multipart/form-data 格式的上传文件夹，返回 (folderName, {relativePath: content})"""
    m = re.search(r"boundary=(?P<b>[^;]+)", content_type, flags=re.IGNORECASE)
    if not m:
        raise ValueError("missing boundary")
    boundary = m.group("b").strip().strip('"')
    if not boundary:
        raise ValueError("missing boundary")
    delimiter = b"--" + boundary.encode("utf-8", errors="ignore")
    
    folder_name = "upload"
    files: dict[str, bytes] = {}
    
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
        
        # 解析 Content-Disposition
        cd_line = ""
        for line in header_text.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                cd_line = line
                break
        
        if not cd_line:
            continue
        
        # 解析字段名
        name_match = re.search(r'name="([^"]+)"', cd_line)
        if not name_match:
            continue
        field_name = name_match.group(1)
        
        if field_name == "folderName":
            # 文件夹名称
            folder_name = body.decode("utf-8", errors="replace").strip()
            if body.endswith(b"\r\n"):
                folder_name = body[:-2].decode("utf-8", errors="replace").strip()
        elif field_name == "files":
            # 文件
            filename_match = re.search(r'filename="([^"]+)"', cd_line)
            if filename_match:
                filename = filename_match.group(1)
                if body.endswith(b"\r\n"):
                    body = body[:-2]
                files[filename] = body
    
    return folder_name, files


def _create_job_upload_folder(handler) -> str:
    """处理上传的文件夹并创建 OCR 任务"""
    content_type = handler.headers.get("Content-Type") or ""
    length = int(handler.headers.get("Content-Length") or "0")
    raw = handler.rfile.read(length) if length > 0 else b""
    
    # 获取 token
    auth_header = handler.headers.get("Authorization") or ""
    token = None
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
    if not token:
        token = handler.headers.get("X-PaddleOCR-Token") or None
    
    folder_name, files = _parse_multipart_folder_upload(content_type, raw)
    
    # 创建临时目录
    import tempfile
    import shutil
    temp_dir = tempfile.mkdtemp()
    
    try:
        # 将上传的文件保存到临时目录
        saved_files = []
        for rel_path, content in files.items():
            # 解析相对路径
            parts = rel_path.replace("\\", "/").split("/")
            if len(parts) > 1:
                # 有子目录
                subdir = os.path.join(temp_dir, parts[0])
                os.makedirs(subdir, exist_ok=True)
                file_path = os.path.join(subdir, "/".join(parts[1:]))
            else:
                file_path = os.path.join(temp_dir, rel_path)
            
            # 确保目录存在
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            
            with open(file_path, "wb") as f:
                f.write(content)
            saved_files.append(file_path)
        
        # 获取真正的文件夹路径（第一级子目录）
        first_file = saved_files[0] if saved_files else None
        if first_file:
            # 检查是否是直接文件还是子目录中的文件
            parts = first_file.replace("\\", "/").split("/")
            # 假设所有文件都在同一文件夹下
            if len(parts) > 1:
                temp_folder = parts[-2]
            else:
                temp_folder = folder_name
        else:
            temp_folder = folder_name
        
        # 创建 job
        local_job_id = uuid.uuid4().hex
        with _jobs_lock:
            _jobs[local_job_id] = {
                "jobId": local_job_id,
                "state": "created",
                "createdAt": _now_ms(),
                "path": temp_dir,
                "isFolder": True,
                "folderName": folder_name,
                "token": token,
            }
        
        # 在后台线程中处理
        t = threading.Thread(target=_run_ocr_from_uploaded_folder, args=(local_job_id, temp_dir, folder_name), daemon=True)
        t.start()
        return local_job_id
        
    except Exception:
        # 清理临时目录
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass
        raise


def _run_ocr_from_uploaded_folder(local_job_id: str, temp_dir: str, folder_name: str) -> None:
    """处理上传的文件夹"""
    try:
        token = _get_job_token(local_job_id)
        _update_job(local_job_id, {"state": "submitting"})
        
        # 找临时目录下的实际文件夹
        actual_folder = temp_dir
        try:
            entries = os.listdir(temp_dir)
            if len(entries) == 1 and os.path.isdir(os.path.join(temp_dir, entries[0])):
                actual_folder = os.path.join(temp_dir, entries[0])
        except Exception:
            pass
        
        safe_folder_name = _safe_folder_name(folder_name)
        base_dir = os.path.join(OUTPUT_ROOT, safe_folder_name, local_job_id)
        os.makedirs(base_dir, exist_ok=True)
        
        # 检查是否有参考答案
        has_answer = _get_answer_folder(actual_folder) is not None
        
        _update_job(local_job_id, {
            "state": "processing_folder",
            "outputDir": base_dir,
            "folderName": folder_name,
            "hasAnswer": has_answer
        })
        
        saved = _process_folder_sync(
            folder_path=actual_folder,
            base_dir=base_dir,
            folder_name=safe_folder_name,
            local_job_id=local_job_id,
            token=token
        )

        # 后台生成合并PDF
        def generate_merged_pdf_async():
            try:
                _ensure_merged_pdf(base_dir, safe_folder_name, local_job_id)
            except Exception as e:
                print(f"[PDF] 后台生成合并PDF失败: {e}")
        threading.Thread(target=generate_merged_pdf_async, daemon=True).start()

        _update_job(
            local_job_id,
            {
                "state": "done",
                "result": {
                    "text": saved["txt"],
                    "pages": saved["pages"],
                    "outputDir": base_dir,
                    "hasAnswer": saved.get("hasAnswer", False),
                    "folderName": saved.get("folderName", folder_name)
                },
                "finishedAt": _now_ms(),
            },
        )
    except Exception as e:
        _update_job(
            local_job_id,
            {"state": "failed", "error": str(e), "finishedAt": _now_ms()},
        )
    finally:
        # 清理临时目录
        try:
            import shutil
            shutil.rmtree(temp_dir)
        except Exception:
            pass


def _get_job_token(job_id: str) -> str | None:
    """获取任务的 token"""
    with _jobs_lock:
        job = _jobs.get(job_id)
        return job.get("token") if job else None


def _run_ocr(local_job_id: str) -> None:
    """后台运行 OCR 任务的线程主逻辑"""
    try:
        token = _get_job_token(local_job_id)
        job = _jobs.get(local_job_id)
        if not job:
            return
        path = job.get("path")
        is_folder = path and os.path.isdir(path)
        
        _update_job(local_job_id, {"state": "submitting"})
        
        if is_folder:
            # 文件夹处理模式
            folder_name = os.path.basename(path.rstrip(os.path.sep)) or "folder"
            safe_folder_name = _safe_folder_name(folder_name)
            base_dir = os.path.join(OUTPUT_ROOT, safe_folder_name, local_job_id)
            os.makedirs(base_dir, exist_ok=True)
            
            # 检查是否有参考答案
            has_answer = _get_answer_folder(path) is not None
            
            _update_job(local_job_id, {
                "state": "processing_folder",
                "outputDir": base_dir,
                "folderName": folder_name,
                "hasAnswer": has_answer
            })
            
            saved = _process_folder_sync(
                folder_path=path,
                base_dir=base_dir,
                folder_name=safe_folder_name,
                local_job_id=local_job_id,
                token=token
            )

            # 后台生成合并PDF
            def generate_merged_pdf_async():
                try:
                    _ensure_merged_pdf(base_dir, safe_folder_name, local_job_id)
                except Exception as e:
                    print(f"[PDF] 后台生成合并PDF失败: {e}")
            threading.Thread(target=generate_merged_pdf_async, daemon=True).start()

            _update_job(
                local_job_id,
                {
                    "state": "done",
                    "result": {
                        "text": saved["txt"],
                        "pages": saved["pages"],
                        "outputDir": base_dir,
                        "hasAnswer": saved.get("hasAnswer", False),
                        "folderName": saved.get("folderName", folder_name)
                    },
                    "finishedAt": _now_ms(),
                },
            )
        else:
            # 单文件处理模式
            language = job.get("language", "zh")
            if job.get("fileName"):
                # 从 job 中获取文件内容（需要先保存）
                file_content = job.get("_fileContent")
                if file_content:
                    remote_job_id = _submit_job_bytes_sync(job["fileName"], file_content, token, language)
                else:
                    remote_job_id = _submit_job_sync(path or "", token=token, language=language)
            else:
                remote_job_id = _submit_job_sync(path or "", token=token, language=language)
            
            # 2. 轮询状态
            _update_job(local_job_id, {"state": "polling", "remoteJobId": remote_job_id})
            zip_url = _poll_job_sync(remote_job_id, local_job_id, token)
            
            # 3. 下载结果
            _update_job(local_job_id, {"state": "downloading", "zipUrl": zip_url})
            zip_resp = _request("GET", zip_url, timeout=300)
            zip_resp.raise_for_status()
            
            # 4. 准备本地保存目录
            folder_name = job.get("fileName") or (os.path.basename(path) if path else "job")
            folder_name = _safe_folder_name(folder_name)

            base_dir = os.path.join(OUTPUT_ROOT, folder_name, local_job_id)
            os.makedirs(base_dir, exist_ok=True)
            base_name = os.path.splitext(folder_name)[0] or folder_name

            # 5. 处理并保存最终结果
            _update_job(local_job_id, {"state": "saving", "outputDir": base_dir})
            saved = _process_mineru_zip(
                zip_resp.content,
                base_dir=base_dir,
                base_name=base_name,
                folder_name=folder_name,
                local_job_id=local_job_id,
            )
            
            # 合并所有页面
            merged_md = "\n\n".join(saved["markdown_parts"])
            merged_txt = "\n\n".join(saved["txt_parts"])
            _write_text(os.path.join(base_dir, "ocr.md"), merged_md)
            _write_text(os.path.join(base_dir, "ocr.txt"), merged_txt)

            # 后台生成合并PDF
            def generate_merged_pdf_async():
                try:
                    _ensure_merged_pdf(base_dir, folder_name, local_job_id)
                except Exception as e:
                    print(f"[PDF] 后台生成合并PDF失败: {e}")
            threading.Thread(target=generate_merged_pdf_async, daemon=True).start()

            # 6. 更新任务为完成
            _update_job(
                local_job_id,
                {
                    "state": "done",
                    "result": {
                        "text": merged_txt,
                        "pages": saved["pages"],
                        "outputDir": base_dir,
                        "hasAnswer": False
                    },
                    "finishedAt": _now_ms(),
                },
            )
    except Exception as e:
        _update_job(
            local_job_id,
            {"state": "failed", "error": str(e), "finishedAt": _now_ms()},
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


def _create_job(path: str, token: str | None = None, language: str = "zh") -> str:
    """创建一个基于路径/URL的 OCR 任务"""
    local_job_id = uuid.uuid4().hex
    is_folder = os.path.isdir(path)
    with _jobs_lock:
        _jobs[local_job_id] = {
            "jobId": local_job_id,
            "state": "created",
            "createdAt": _now_ms(),
            "path": path,
            "isFolder": is_folder,
            "token": token,
            "language": language,
        }
    t = threading.Thread(target=_run_ocr, args=(local_job_id,), daemon=True)
    t.start()
    return local_job_id


def _create_job_upload(filename: str, content: bytes, token: str | None = None, language: str = "zh") -> str:
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
            "token": token,
            "language": language,
            "_fileContent": content,
        }
    t = threading.Thread(
        target=_run_ocr, args=(local_job_id,), daemon=True
    )
    t.start()
    return local_job_id


class Handler(BaseHTTPRequestHandler):
    """自定义 HTTP 请求处理器"""
    protocol_version = "HTTP/1.1"
    
    # 获取项目根目录，以便提供前端静态文件服务
    ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")

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
            
            # 处理静态文件请求
            if not parsed.path.startswith("/api/") and not parsed.path.startswith("/output/") and parsed.path != "/health":
                # 默认为 index.html
                target_path = "/index.html" if parsed.path == "/" else parsed.path
                
                # 安全处理路径，防止目录遍历
                target_path = target_path.lstrip("/")
                file_path = os.path.abspath(os.path.join(self.FRONTEND_DIR, target_path))
                
                # 确保请求的文件在前端目录下
                if not file_path.startswith(os.path.abspath(self.FRONTEND_DIR)):
                    self._send(403, _json_bytes({"error": "forbidden"}))
                    return
                    
                if os.path.isfile(file_path):
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
                else:
                    self._send(404, _json_bytes({"error": "not_found"}))
                return

            # ----------------------------------------------------
            # API 路由
            # ----------------------------------------------------

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

            # 获取某个任务关联的所有素材（图片、PDF、res文件等）
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

                allow_img_exts = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}
                allow_pdf_exts = {".pdf"}
                allow_res_exts = {".txt"}
                files = []

                def scan_directory(directory, prefix=""):
                    """递归扫描目录"""
                    try:
                        for name in os.listdir(directory):
                            fpath = os.path.join(directory, name)
                            if os.path.isdir(fpath):
                                # 跳过 output 目录（单独处理）
                                if name != "output":
                                    sub_prefix = prefix + name + "/" if prefix else name + "/"
                                    scan_directory(fpath, sub_prefix)
                            elif os.path.isfile(fpath):
                                _, ext = os.path.splitext(name)
                                ext = ext.lower()
                                if ext in allow_img_exts:
                                    rel_path = prefix + name if prefix else name
                                    # url_path 包含完整路径，name 只返回文件名（不含前缀目录）
                                    url_path = f"output/{folder_name}/{job_id}/{rel_path}"
                                    files.append({
                                        "name": name,  # 只返回文件名，方便前端匹配
                                        "url": url_path,
                                        "type": "image"
                                    })
                                elif ext in allow_pdf_exts:
                                    rel_path = prefix + name if prefix else name
                                    url_path = f"output/{folder_name}/{job_id}/{rel_path}"
                                    files.append({
                                        "name": name,
                                        "url": url_path,
                                        "type": "pdf"
                                    })
                                elif name.startswith("res_") and ext in allow_res_exts:
                                    # res 文件在 txt/ 子目录中
                                    rel_path = name if not prefix else prefix + name
                                    url_path = f"output/{folder_name}/{job_id}/{rel_path}"
                                    files.append({
                                        "name": name,
                                        "url": url_path,
                                        "type": "res"
                                    })
                    except Exception:
                        pass

                scan_directory(job_dir)

                # 同时扫描 output/imgs 目录（OCR API 返回的图片）
                output_imgs_dir = os.path.join(job_dir, "output", "imgs")
                if os.path.isdir(output_imgs_dir):
                    try:
                        for name in os.listdir(output_imgs_dir):
                            fpath = os.path.join(output_imgs_dir, name)
                            if os.path.isfile(fpath):
                                _, ext = os.path.splitext(name)
                                ext = ext.lower()
                                if ext in allow_img_exts:
                                    rel_path = f"output/imgs/{name}"
                                    url_path = f"output/{folder_name}/{job_id}/output/imgs/{name}"
                                    files.append({
                                        "name": name,
                                        "url": url_path,
                                        "type": "api_image"
                                    })
                    except Exception:
                        pass

                # 添加合并后的PDF（如果存在）
                merged_pdf_path = _get_merged_pdf_path(job_dir, folder_name, job_id)
                if os.path.exists(merged_pdf_path):
                    files.append({
                        "name": "merged.pdf",
                        "url": f"output/{folder_name}/{job_id}/merged.pdf",
                        "type": "merged_pdf"
                    })

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
                
                # 读取元数据文件获取 hasAnswer
                has_answer = False
                try:
                    meta_file = os.path.join(job_dir, "meta.json")
                    if os.path.exists(meta_file):
                        with open(meta_file, "r", encoding="utf-8") as f:
                            meta_data = json.load(f)
                            has_answer = meta_data.get("hasAnswer", False)
                    else:
                        # 兼容旧数据：检查参考答案目录是否存在
                        answer_dir = os.path.join(job_dir, "参考答案")
                        has_answer = os.path.isdir(answer_dir)
                except Exception:
                    pass
                
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
                            "hasAnswer": has_answer,
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
                has_answer = data.get("hasAnswer", False)
                print(f"[API] 分割请求: outputDir={output_dir}, hasAnswer={has_answer}")
                if output_dir and (not os.path.isdir(output_dir) or not _is_under_output_root(output_dir)):
                    output_dir = None
                if not subject:
                    self._send(400, _json_bytes({"error": "missing_subject"}))
                    return
                if not text:
                    self._send(400, _json_bytes({"error": "missing_text"}))
                    return
                # 传递 subject 给后端，由后端统一拼接
                job_id = _create_coze_job(text, output_dir, has_answer, subject)
                self._send(200, _json_bytes({"jobId": job_id}))
                return
            
            # 上传文件并识别
            if parsed.path == "/api/ocr/upload":
                content_type = self.headers.get("Content-Type") or ""
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length > 0 else b""
                filename, content = _parse_multipart_file(content_type, raw)
                # 支持从 Authorization header 或自定义 header 获取 token
                auth_header = self.headers.get("Authorization") or ""
                token = None
                if auth_header.startswith("Bearer "):
                    token = auth_header[7:].strip()
                # 也支持从 X-PaddleOCR-Token header 获取
                if not token:
                    token = self.headers.get("X-PaddleOCR-Token") or None
                    
                language = self.headers.get("X-Language", "zh")
                
                job_id = _create_job_upload(filename, content, token, language)
                self._send(200, _json_bytes({"jobId": job_id}))
                return

            # 上传文件夹并识别
            if parsed.path == "/api/ocr/upload-folder":
                job_id = _create_job_upload_folder(self)
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
            token = (data.get("token") or "").strip() or None
            if not path:
                self._send(400, _json_bytes({"error": "missing_path"}))
                return
            # 支持文件夹路径或文件路径
            if not path.startswith("http") and not os.path.exists(path):
                self._send(400, _json_bytes({"error": "file_not_found"}))
                return
            job_id = _create_job(path, token)
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
