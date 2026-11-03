#!/usr/bin/env python3
"""Create a portable offline zip from the prepared local project."""
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
DIRECTORIES = ["web", "scripts", "docs", "tests", "launcher"]
FILES = ["README.md", "THIRD_PARTY_NOTICES.md", "LICENSE", "start.py", "start.bat", "Dockerfile", "compose.yaml", ".dockerignore", "package.json", "package-lock.json"]
LAUNCHER_FILES = ["start_game.py", "双击启动游戏.bat", "README-一键版.txt"]
ASSETS = [
    "vendor/vision_bundle.mjs",
    "vendor/wasm/vision_wasm_internal.js",
    "vendor/wasm/vision_wasm_internal.wasm",
    "vendor/wasm/vision_wasm_nosimd_internal.js",
    "vendor/wasm/vision_wasm_nosimd_internal.wasm",
    "vendor/wasm/vision_wasm_module_internal.js",
    "vendor/wasm/vision_wasm_module_internal.wasm",
    "models/pose_landmarker_lite.task",
]


def preflight(root):
    missing = [name + "/" for name in DIRECTORIES if not (root / name).is_dir()]
    required = FILES + ["launcher/" + name for name in LAUNCHER_FILES]
    missing += [name for name in required if not (root / name).is_file()]
    missing += ["web/" + name for name in ASSETS
                if not (root / "web" / name).is_file() or (root / "web" / name).stat().st_size == 0]
    if missing:
        raise ValueError(
            "Cannot create a complete offline package; missing or empty resources:\n  - "
            + "\n  - ".join(missing)
            + "\nRestore project files and run: python3 scripts/setup_assets.py"
        )


def create_package(root=ROOT, output=None):
    root = Path(root)
    preflight(root)
    output = Path(output) if output is not None else root / "deliverables/movecraft-island-offline.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    # Keep the previous complete archive if reading or compression fails.
    with NamedTemporaryFile(dir=output.parent, suffix=".zip", delete=False) as temporary:
        staging = Path(temporary.name)
    try:
        with ZipFile(staging, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            for name in FILES:
                archive.write(root / name, f"movecraft-island/{name}")
            for directory in DIRECTORIES:
                for path in sorted((root / directory).rglob("*")):
                    if path.is_file() and "__pycache__" not in path.parts:
                        archive.write(path, "movecraft-island/" + path.relative_to(root).as_posix())
        staging.replace(output)
    finally:
        staging.unlink(missing_ok=True)
    return output


def main():
    try:
        output = create_package()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"Offline package: {output} ({output.stat().st_size / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
