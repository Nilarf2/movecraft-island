#!/usr/bin/env python3
"""Serve the self-contained game using only the Python standard library."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import webbrowser


def main():
    parser = argparse.ArgumentParser(description="MoveCraft local server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).parent
    required = ["vendor/vision_bundle.mjs", "vendor/wasm/vision_wasm_internal.wasm", "models/pose_landmarker_lite.task"]
    if any(not (root / "web" / name).is_file() for name in required):
        parser.exit(1, "Game assets are missing. Run: python3 scripts/setup_assets.py\nWindows: py -3 scripts/setup_assets.py\n")
    handler = partial(SimpleHTTPRequestHandler, directory=str(root / "web"))
    handler.func.extensions_map.update({".wasm": "application/wasm", ".mjs": "text/javascript", ".task": "application/octet-stream"})
    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as error:
        parser.exit(1, f"Cannot listen on {args.host}:{args.port}: {error}\nTry --port 8788.\n")
    address = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    url = f"http://{address}:{server.server_port}"
    print(f"MoveCraft: {url}\nPress Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
