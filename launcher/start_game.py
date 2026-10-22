#!/usr/bin/env python3
"""MoveCraft one-click launcher.

Runs with the bundled Python runtime so the recipient installs nothing:
finds a free port, serves the game, and opens the browser. Closing the
console window stops the server.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import sys
import threading
import traceback
import webbrowser

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
REQUIRED = [
    "vendor/vision_bundle.mjs",
    "vendor/wasm/vision_wasm_internal.wasm",
    "models/pose_landmarker_lite.task",
]
PORTS = [8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794]


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".mjs": "text/javascript",
        ".task": "application/octet-stream",
    }

    def end_headers(self):
        # The game is fully local; never let a proxy or cache serve stale assets.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console clean for non-technical players


def pick_port():
    for port in PORTS:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return None


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


def main():
    missing = [name for name in REQUIRED if not (WEB / name).is_file()]
    if missing:
        print("游戏资源缺失，无法启动：")
        for name in missing:
            print("  - web/" + name)
        print()
        print("请重新解压完整的压缩包，不要只复制部分文件。")
        input("按回车键关闭…")
        return 1

    port = pick_port()
    if port is None:
        print("端口 " + str(PORTS[0]) + "-" + str(PORTS[-1]) + " 都被占用了。")
        print("请关闭一些程序（或重启电脑）后再试。")
        input("按回车键关闭…")
        return 1

    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(WEB)))
    except OSError as error:
        print("无法启动本地服务：" + str(error))
        input("按回车键关闭…")
        return 1

    url = "http://localhost:" + str(port)
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
        sys.exit(main())
    except Exception:
        print("\n启动时出现意外错误：\n")
        traceback.print_exc()
        input("\n请把上面的内容截图反馈。按回车键关闭…")
        sys.exit(1)
