#!/usr/bin/env python3
"""Download the embedded Python runtime used by the double-click package.

Windows only. Fetches the official python.org embeddable build, which needs no
installer and no administrator rights, then unpacks it into runtime/.
Idempotent: does nothing when runtime/python.exe already exists.
"""
from io import BytesIO
from pathlib import Path
import shutil
import sys
import urllib.request
from zipfile import ZipFile

VERSION = "3.11.9"
URL = f"https://www.python.org/ftp/python/{VERSION}/python-{VERSION}-embed-amd64.zip"
ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "runtime"


def main():
    if sys.platform != "win32":
        sys.exit("The bundled runtime is Windows amd64 only; build the package on Windows.")
    if (TARGET / "python.exe").is_file():
        print(f"Runtime already present: {TARGET}")
        return
    print(f"Downloading Python {VERSION} embeddable runtime…", flush=True)
    with urllib.request.urlopen(URL, timeout=180) as response:
        archive = response.read()
    TARGET.mkdir(parents=True, exist_ok=True)
    with ZipFile(BytesIO(archive)) as package:
        package.extractall(TARGET)
    # The isolated runtime must still find its own standard library zip; the
    # shipped ._pth already lists python311.zip and ".", so leave it untouched.
    if not (TARGET / "python.exe").is_file():
        sys.exit("Runtime extraction failed: python.exe missing")
    print(f"Runtime ready: {TARGET}")
    print("Next: python scripts/package_oneclick.py")


if __name__ == "__main__":
    main()
