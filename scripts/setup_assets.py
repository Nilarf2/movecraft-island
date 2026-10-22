#!/usr/bin/env python3
"""Download pinned, self-hosted MediaPipe assets. No third-party Python packages."""
from io import BytesIO
from pathlib import Path
import shutil
import tarfile
import urllib.request

VERSION = "1.1.1"
ROOT = Path(__file__).resolve().parent.parent / "web"
PACKAGE = f"https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-{VERSION}.tgz"
MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
FILES = ["vision_bundle.mjs", "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm", "wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm", "wasm/vision_wasm_module_internal.js", "wasm/vision_wasm_module_internal.wasm"]


def main():
    vendor = ROOT / "vendor"
    if any(not (vendor / name).is_file() for name in FILES):
        print(f"Downloading MediaPipe Tasks Vision {VERSION}...", flush=True)
        with urllib.request.urlopen(PACKAGE, timeout=120) as response:
            archive = response.read()
        with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as package:
            for name in FILES:
                target = vendor / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(f"package/{name}") as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
    model = ROOT / "models/pose_landmarker_lite.task"
    if not model.is_file():
        print("Downloading Pose Landmarker Lite, model version 1...", flush=True)
        model.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(MODEL, timeout=120) as source, model.open("wb") as output:
            shutil.copyfileobj(source, output)
    print("Assets ready. Run: python3 start.py", flush=True)


if __name__ == "__main__":
    main()
