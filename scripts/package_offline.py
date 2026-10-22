#!/usr/bin/env python3
"""Create a portable offline zip from the prepared local project."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
output = root / "deliverables/movecraft-island-offline.zip"
output.parent.mkdir(exist_ok=True)
directories = ["web", "scripts", "docs", "tests"]
files = ["README.md", "THIRD_PARTY_NOTICES.md", "LICENSE", "start.py", "start.bat", "Dockerfile", "compose.yaml", ".dockerignore", "package.json", "package-lock.json"]
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
    for name in files:
        archive.write(root / name, f"movecraft-island/{name}")
    for directory in directories:
        for path in (root / directory).rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                archive.write(path, "movecraft-island/" + path.relative_to(root).as_posix())
print(f"Offline package: {output} ({output.stat().st_size / 1024 / 1024:.1f} MB)")
