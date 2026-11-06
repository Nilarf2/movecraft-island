#!/usr/bin/env python3
"""MoveCraft one-click launcher.

Runs with the bundled Python runtime so the recipient installs nothing:
finds a free port, serves the game, and opens the browser. Closing the
console window stops the server.

    start_game.py                       opens /           (the personal game)
    start_game.py --path /stage.html    opens the big-screen page
"""
import argparse
from functools import partial
from hashlib import sha256
from http.client import HTTPConnection, HTTPException
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import traceback
from urllib.parse import unquote, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
REQUIRED = [
    "vendor/vision_bundle.mjs",
    "vendor/wasm/vision_wasm_internal.js",
    "vendor/wasm/vision_wasm_internal.wasm",
    "vendor/wasm/vision_wasm_nosimd_internal.js",
    "vendor/wasm/vision_wasm_nosimd_internal.wasm",
    "vendor/wasm/vision_wasm_module_internal.js",
    "vendor/wasm/vision_wasm_module_internal.wasm",
    "models/pose_landmarker_lite.task",
]
PORTS = [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794]
INSTANCE_PATH = "/__movecraft_launcher_instance__"


def instance_identity(web):
    # Compare roots without disclosing a user's filesystem path over HTTP.
    root = os.path.normcase(str(Path(web).resolve()))
    return {"application": "movecraft-island-launcher", "protocol": 1,
            "root": sha256(root.encode("utf-8")).hexdigest()}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".task": "application/octet-stream",
    }

    def do_GET(self):
        if self.path == INSTANCE_PATH:
            payload = json.dumps(instance_identity(self.directory)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def end_headers(self):
        # The game is fully local; never let a proxy or cache serve stale assets.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console clean for non-technical players


def is_same_instance(port, web):
    # Direct loopback HTTP deliberately bypasses system or environment proxies.
    connection = HTTPConnection("127.0.0.1", port, timeout=0.3)
    try:
        connection.request("GET", INSTANCE_PATH)
        response = connection.getresponse()
        if response.status != 200:
            return False
        payload = response.read(2049)
        return len(payload) <= 2048 and json.loads(payload) == instance_identity(web)
    except (OSError, HTTPException, ValueError):
        return False
    finally:
        connection.close()


def acquire_server(web=WEB, ports=PORTS):
    # Search every candidate first: an earlier port may have become free since
    # the existing game started, but changing origins would hide its save.
    for port in ports:
        if port and is_same_instance(port, web):
            return None, port
    for port in ports:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(web)))
            return server, server.server_port
        except OSError:
            if port and is_same_instance(port, web):
                return None, port
    return None, None


def page_target(raw):
    """Check --path: a page of this local server such as /stage.html, never another site.

    Returns (path for the URL, file name under web/)."""
    text = (raw or "/").strip()
    if not text.startswith("/"):
        text = "/" + text
    parts = urlsplit(text)
    if (text.startswith("//") or "://" in text or "\\" in text or parts.scheme or parts.netloc
            or any(char.isspace() or ord(char) < 32 for char in text)
            or ".." in parts.path.split("/")):
        raise ValueError(raw)
    page = unquote(parts.path[1:])
    if page == "" or page.endswith("/"):
        page += "index.html"
    return text, page


def banner(url):
    line = "=" * 46
    print(line)
    print("   MoveCraft · 体感荒岛  已启动")
    print(line)
    print()
    print("   游戏地址:  " + url)
    print()
    print("   浏览器会自动打开。如果没有，请手动复制上面的地址")
    print("   粘贴到 Chrome 或 Edge 的地址栏。")
    print()
    print("   · 第一次用摄像头时，浏览器会询问是否允许，请点「允许」")
    print("   · 玩完后直接关闭这个黑色窗口即可")
    print()
    print(line)
    print("   请保持此窗口开着，关掉它游戏就会停止。")
    print(line, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="MoveCraft 一键启动")
    parser.add_argument("--path", default="/", help="要打开的页面，例如 /stage.html（默认 /）")
    args = parser.parse_args([] if argv is None else argv)
    try:
        path, page = page_target(args.path)
    except ValueError:
        print("启动参数 --path 无效：" + str(args.path))
        print("只能填本程序里的页面路径，例如 /stage.html。")
        return 2

    missing = [name for name in REQUIRED
               if not (WEB / name).is_file() or (WEB / name).stat().st_size == 0]
    if missing:
        print("游戏资源缺失，无法启动：")
        for name in missing:
            print("  - web/" + name)
        print()
        print("请重新解压完整的压缩包，不要只复制部分文件。")
        input("按回车键关闭…")
        return 1
    if not (WEB / page).is_file():
        print("找不到要打开的页面：web/" + page)
        print()
        print("请重新解压完整的压缩包，不要只复制部分文件。")
        input("按回车键关闭…")
        return 1

    server, port = acquire_server()
    if port is None:
        print("端口 " + str(PORTS[0]) + "-" + str(PORTS[-1]) + " 都被占用了。")
        print("请关闭一些程序（或重启电脑）后再试。")
        input("按回车键关闭…")
        return 1

    url = "http://localhost:" + str(port) + ("" if path == "/" else path)
    if server is None:
        print("同一文件夹的游戏已经运行，正在打开原来的游戏地址：" + url, flush=True)
        print("存档继续使用原地址。请保持原来的启动窗口开着。", flush=True)
        webbrowser.open(url)
        return 0
    if port != PORTS[0]:
        print("默认端口被其他程序占用，游戏改用：" + url, flush=True)
        print("注意：浏览器存档按地址和端口分别保存，换端口不会自动显示原存档。", flush=True)
        print("如需原存档，请先关闭占用程序再重开，或从原地址导出后导入。", flush=True)
    banner(url)
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        print("\n启动时出现意外错误：\n")
        traceback.print_exc()
        input("\n请把上面的内容截图反馈。按回车键关闭…")
        sys.exit(1)
