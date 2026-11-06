#!/usr/bin/env python3
"""Build the double-click package for people who do not want to install anything.

The result is a zip that contains:
  - the prepared web assets (vendor runtime + pose model, so no download)
  - a bundled, embedded Python 3.11 runtime (no Python install needed)
  - start_game.py, a friendly launcher that picks a free port and opens the browser
  - 双击启动游戏.bat (personal game), 大屏模式.bat (/stage.html), 性能测试.bat (/perf-lab.html)
  - server/, the local account and leaderboard API the launcher embeds
  - README-一键版.txt

The embedded runtime is not committed to git. Fetch it once before building:

    python scripts/fetch_runtime.py
    python scripts/package_oneclick.py                      # deliverables/movecraft-island-oneclick.zip
    python scripts/package_oneclick.py path/to/other.zip    # optional output path

Windows only: the bundled runtime is win-amd64.
"""
import argparse
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "launcher"
RUNTIME = ROOT / "runtime"
WEB = ROOT / "web"
SERVER = ROOT / "server"
OUTPUT = ROOT / "deliverables/movecraft-island-oneclick.zip"
FOLDER = "MoveCraft-体感荒岛"
SKIP_PARTS = {"__pycache__", "tests", ".data"}
LAUNCHER_FILES = ("双击启动游戏.bat", "大屏模式.bat", "性能测试.bat", "start_game.py", "README-一键版.txt")
REQUIRED_ASSETS = ["models/pose_landmarker_lite.task", "vendor/vision_bundle.mjs",
                   "vendor/wasm/vision_wasm_internal.js", "vendor/wasm/vision_wasm_internal.wasm",
                   "vendor/wasm/vision_wasm_nosimd_internal.js", "vendor/wasm/vision_wasm_nosimd_internal.wasm",
                   "vendor/wasm/vision_wasm_module_internal.js", "vendor/wasm/vision_wasm_module_internal.wasm"]


def add_tree(archive, source, prefix):
    count = 0
    for path in sorted(source.rglob("*")):
        if not path.is_file() or SKIP_PARTS & set(path.parts):
            continue
        archive.write(path, f"{FOLDER}/{prefix}{path.relative_to(source).as_posix()}")
        count += 1
    return count


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the MoveCraft one-click Windows package")
    parser.add_argument("output", nargs="?", help="zip to write (default: deliverables/movecraft-island-oneclick.zip)")
    args = parser.parse_args([] if argv is None else argv)
    output = Path(args.output).resolve() if args.output else OUTPUT
    if not (RUNTIME / "python.exe").is_file():
        sys.exit(
            "Bundled runtime missing.\n"
            f"Expected: {RUNTIME / 'python.exe'}\n"
            "Run: python scripts/fetch_runtime.py"
        )
    if missing := [name for name in REQUIRED_ASSETS if not (WEB / name).is_file() or (WEB / name).stat().st_size == 0]:
        sys.exit("Game assets are missing: " + ", ".join(missing) + "\nRun: python scripts/setup_assets.py")

    for name in LAUNCHER_FILES:
        if not (LAUNCHER / name).is_file():
            sys.exit(f"Launcher file missing: {LAUNCHER / name}")
    for name in ("__init__.py", "app.py", "serve.py"):
        if not (SERVER / name).is_file():
            sys.exit(f"Account server file missing: {SERVER / name}")
    # A zip written into a packed folder would end up inside itself.
    for source in (WEB, RUNTIME, LAUNCHER, SERVER, ROOT / "docs"):
        if output.resolve().is_relative_to(source.resolve()):
            sys.exit(f"Output must not be inside {source}: {output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    # Keep the previous complete package if reading or compression fails.
    with NamedTemporaryFile(dir=output.parent, suffix=".zip", delete=False) as temporary:
        staging = Path(temporary.name)
    files = 0
    try:
        with ZipFile(staging, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            for name in LAUNCHER_FILES:
                archive.write(LAUNCHER / name, f"{FOLDER}/{name}")
                files += 1
            files += add_tree(archive, WEB, "web/")
            files += add_tree(archive, SERVER, "server/")
            if (ROOT / "docs").is_dir():
                files += add_tree(archive, ROOT / "docs", "docs/")
            for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
                if (ROOT / name).is_file():
                    archive.write(ROOT / name, f"{FOLDER}/{name}")
                    files += 1
            files += add_tree(archive, RUNTIME, "runtime/")
        staging.replace(output)
    finally:
        staging.unlink(missing_ok=True)
    print(f"One-click package: {output}")
    print(f"  files: {files}")
    print(f"  size : {output.stat().st_size / 1024 / 1024:.1f} MB")
    print()
    print("Send this zip as-is. The recipient unzips it and double-clicks 双击启动游戏.bat")
    print("(大屏模式.bat opens the big-screen page, 性能测试.bat the hardware check).")
    return output


if __name__ == "__main__":
    main(sys.argv[1:])
