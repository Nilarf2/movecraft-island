#!/usr/bin/env python3
"""Download pinned, self-hosted MediaPipe assets. No third-party Python packages."""
from io import BytesIO
import hashlib
from pathlib import Path
import os
import tempfile
import tarfile
import urllib.request

VERSION = "1.1.1"
ROOT = Path(__file__).resolve().parent.parent / "web"
PACKAGE = f"https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-{VERSION}.tgz"
MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
FILES = ["vision_bundle.mjs", "wasm/vision_wasm_internal.js", "wasm/vision_wasm_internal.wasm", "wasm/vision_wasm_nosimd_internal.js", "wasm/vision_wasm_nosimd_internal.wasm", "wasm/vision_wasm_module_internal.js", "wasm/vision_wasm_module_internal.wasm"]
REQUIRED_ASSETS = [f"vendor/{name}" for name in FILES] + ["models/pose_landmarker_lite.task"]
MINIMUM_BYTES = {"vision_bundle.mjs": 100_000, "models/pose_landmarker_lite.task": 1_000_000}
MINIMUM_BYTES.update({name: 1_000_000 if name.endswith(".wasm") else 100_000 for name in FILES if name != "vision_bundle.mjs"})
# Digests pin the prepared, locally verified 1.1.1 runtime and version 1 Lite model.
SHA256 = {
    "vision_bundle.mjs": "a84921e02321e582484c1f8126d344b5f33b791fa09c640a52e20ee8632068f1",
    "wasm/vision_wasm_internal.js": "6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8",
    "wasm/vision_wasm_internal.wasm": "0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd",
    "wasm/vision_wasm_nosimd_internal.js": "942654dbdcebce08ea039af23d18e58bebf23c8607d74023d2df7071c8a7b638",
    "wasm/vision_wasm_nosimd_internal.wasm": "c9b1b69bb87baf9e529254d8559dcbcf4c5a9c0eda84f56a12f17d675335ec9c",
    "wasm/vision_wasm_module_internal.js": "539a4386fd12d0723d6e900ec80467d168ba7290dda2f79e77a2181b8e906115",
    "wasm/vision_wasm_module_internal.wasm": "3b57e4b55ac6346bf940212e3e11250b308a6a474077385e2f527b119cf74525",
    "models/pose_landmarker_lite.task": "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
}


def valid(path, key):
    try:
        if not path.is_file() or path.stat().st_size < MINIMUM_BYTES[key]:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest() == SHA256[key]
    except OSError:
        return False


def download_file(url, target, key):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".", delete=False) as output:
            temporary = Path(output.name)
            with urllib.request.urlopen(url, timeout=120) as source:
                while block := source.read(1024 * 1024):
                    output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if not valid(temporary, key):
            raise ValueError(f"Downloaded asset is incomplete or failed SHA-256 validation: {key}")
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    vendor = ROOT / "vendor"
    if any(not valid(vendor / name, name) for name in FILES):
        print(f"Downloading MediaPipe Tasks Vision {VERSION}...", flush=True)
        with urllib.request.urlopen(PACKAGE, timeout=120) as response:
            archive = response.read()
        vendor.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=vendor.parent, prefix="mediapipe-") as staging_name:
            staging = Path(staging_name)
            with tarfile.open(fileobj=BytesIO(archive), mode="r:gz") as package:
                for name in FILES:
                    source = package.extractfile(f"package/{name}")
                    if source is None:
                        raise ValueError(f"MediaPipe archive is missing {name}")
                    staged = staging / name
                    staged.parent.mkdir(parents=True, exist_ok=True)
                    with source, staged.open("wb") as output:
                        while block := source.read(1024 * 1024):
                            output.write(block)
                    if not valid(staged, name):
                        raise ValueError(f"MediaPipe asset is incomplete or failed SHA-256 validation: {name}")
            for name in FILES:
                target = vendor / name
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staging / name, target)
    model = ROOT / "models/pose_landmarker_lite.task"
    if not valid(model, "models/pose_landmarker_lite.task"):
        print("Downloading Pose Landmarker Lite, model version 1...", flush=True)
        download_file(MODEL, model, "models/pose_landmarker_lite.task")
    print("Assets ready. Run: python3 start.py", flush=True)


if __name__ == "__main__":
    main()
