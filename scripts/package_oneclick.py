#!/usr/bin/env python3
"""Build the double-click package for people who do not want to install anything.

The result is a zip that contains:
  - the prepared web assets (vendor runtime + pose model, so no download)
  - a bundled, embedded Python 3.11 runtime (no Python install needed)
  - start_game.py, a friendly launcher that picks a free port and opens the browser
  - 双击启动游戏.bat
  - README-一键版.txt

The embedded runtime is not committed to git. Fetch it once before building:

    python scripts/fetch_runtime.py
    python scripts/package_oneclick.py

Windows only: the bundled runtime is win-amd64.
"""
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "launcher"
RUNTIME = ROOT / "runtime"
WEB = ROOT / "web"
OUTPUT = ROOT / "deliverables/movecraft-island-oneclick.zip"
FOLDER = "MoveCraft-体感荒岛"
SKIP_PARTS = {"__pycache__"}


def add_tree(archive, source, prefix):
    count = 0
    for path in sorted(source.rglob("*")):
        if not path.is_file() or SKIP_PARTS & set(path.parts):
            continue
        archive.write(path, f"{FOLDER}/{prefix}{path.relative_to(source).as_posix()}")
        count += 1
    return count


def main():
    if not (RUNTIME / "python.exe").is_file():
        sys.exit(
            "Bundled runtime missing.\n"
            f"Expected: {RUNTIME / 'python.exe'}\n"
            "Run: python scripts/fetch_runtime.py"
        )
    required = ["models/pose_landmarker_lite.task", "vendor/vision_bundle.mjs", "vendor/wasm/vision_wasm_internal.wasm"]
    if missing := [name for name in required if not (WEB / name).is_file()]:
        sys.exit("Game assets are missing: " + ", ".join(missing) + "\nRun: python scripts/setup_assets.py")

    for name in ("双击启动游戏.bat", "start_game.py", "README-一键版.txt"):
        if not (LAUNCHER / name).is_file():
            sys.exit(f"Launcher file missing: {LAUNCHER / name}")

    OUTPUT.parent.mkdir(exist_ok=True)
    files = 0
    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
        for name in ("双击启动游戏.bat", "start_game.py", "README-一键版.txt"):
            archive.write(LAUNCHER / name, f"{FOLDER}/{name}")
            files += 1
        files += add_tree(archive, WEB, "web/")
        if (ROOT / "docs").is_dir():
            files += add_tree(archive, ROOT / "docs", "docs/")
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            if (ROOT / name).is_file():
                archive.write(ROOT / name, f"{FOLDER}/{name}")
                files += 1
        files += add_tree(archive, RUNTIME, "runtime/")
    print(f"One-click package: {OUTPUT}")
    print(f"  files: {files}")
    print(f"  size : {OUTPUT.stat().st_size / 1024 / 1024:.1f} MB")
    print()
    print("Send this zip as-is. The recipient unzips it and double-clicks 双击启动游戏.bat.")


if __name__ == "__main__":
    main()
