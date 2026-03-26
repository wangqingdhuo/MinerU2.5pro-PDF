#!/usr/bin/env python3
"""
PaddleDev 前端静态文件服务器
监听 0.0.0.0:5174，允许局域网访问
"""

import os
import mimetypes
from http.server import HTTPServer, SimpleHTTPRequestHandler

HOST = "0.0.0.0"
PORT = 5174

# 获取脚本所在目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(SCRIPT_DIR, "frontend")


class CORSRequestHandler(SimpleHTTPRequestHandler):
    """支持 CORS 的静态文件处理器"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def end_headers(self):
        # 添加 CORS 头
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        """处理 GET 请求"""
        if self.path == "/" or self.path == "":
            self.path = "/index.html"
        return super().do_GET()


def main():
    # 确保前端目录存在
    if not os.path.isdir(FRONTEND_DIR):
        print(f"错误: 前端目录不存在: {FRONTEND_DIR}")
        return

    # 设置 MIME 类型
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("application/json", ".json")

    server = HTTPServer((HOST, PORT), CORSRequestHandler)
    print(f"前端服务已启动: http://{HOST}:{PORT}")
    print(f"局域网访问: http://<本机IP>:{PORT}")
    print(f"按 Ctrl+C 停止服务")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
