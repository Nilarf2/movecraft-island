"""Asset preparation and local launch regressions without network access."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
from scripts import setup_assets as setup
import start


def load_package():
    spec = importlib.util.spec_from_file_location("package_offline_assets_test", PROJECT_ROOT / "scripts/package_offline.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive_for(contents):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:gz") as archive:
        for name, data in contents.items():
            entry = tarfile.TarInfo("package/" + name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return result.getvalue()


class InterruptedDownload(io.BytesIO):
    def read(self, *args):
        if self.tell():
            raise OSError("connection interrupted")
        return super().read(5)


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.web = self.root / "web"
        self.contents = {name: ("verified asset: " + name).encode() for name in setup.FILES}
        self.contents["models/pose_landmarker_lite.task"] = b"verified pose model"
        minimum = {name: 1 for name in self.contents}
        digests = {name: hashlib.sha256(data).hexdigest() for name, data in self.contents.items()}
        for attribute, value in (("ROOT", self.web), ("MINIMUM_BYTES", minimum), ("SHA256", digests)):
            patcher = patch.object(setup, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, data in self.contents.items():
            self.asset_path(name).parent.mkdir(parents=True, exist_ok=True)
            self.asset_path(name).write_bytes(data)

    def asset_path(self, name):
        return self.web / name if name.startswith("models/") else self.web / "vendor" / name

    def run_setup(self, response):
        with patch.object(setup.urllib.request, "urlopen", side_effect=response) as download, redirect_stdout(io.StringIO()):
            setup.main()
        return download

    def test_package_and_setup_require_the_same_assets(self):
        self.assertEqual(set(setup.REQUIRED_ASSETS), set(load_package().ASSETS))
        self.assertEqual(set(setup.SHA256), set(setup.FILES) | {"models/pose_landmarker_lite.task"})

    def test_valid_existing_files_are_reused_without_network(self):
        download = self.run_setup(AssertionError("unexpected download"))
        download.assert_not_called()

    def test_corruption_with_unchanged_size_is_detected(self):
        path = self.asset_path(setup.FILES[0])
        path.write_bytes(b"x" * path.stat().st_size)
        self.assertFalse(setup.valid(path, setup.FILES[0]))

    def test_interrupted_model_download_preserves_old_file_and_retries(self):
        name = "models/pose_landmarker_lite.task"
        path = self.asset_path(name)
        path.write_bytes(b"old incomplete model")
        with self.assertRaisesRegex(OSError, "connection interrupted"):
            self.run_setup(lambda *_args, **_kwargs: InterruptedDownload(self.contents[name]))
        self.assertEqual(path.read_bytes(), b"old incomplete model")
        self.assertEqual(list(path.parent.iterdir()), [path])
        download = self.run_setup(lambda *_args, **_kwargs: io.BytesIO(self.contents[name]))
        self.assertEqual(download.call_count, 1)
        self.assertEqual(path.read_bytes(), self.contents[name])

    def test_invalid_model_download_does_not_replace_previous_file(self):
        name = "models/pose_landmarker_lite.task"
        path = self.asset_path(name)
        path.write_bytes(b"old model")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.run_setup(lambda *_args, **_kwargs: io.BytesIO(b"wrong model"))
        self.assertEqual(path.read_bytes(), b"old model")
        self.assertEqual(list(path.parent.iterdir()), [path])

    def test_invalid_package_never_replaces_any_vendor_file(self):
        broken = setup.FILES[0]
        self.asset_path(broken).write_bytes(b"old corrupt asset")
        before = {name: self.asset_path(name).read_bytes() for name in setup.FILES}
        contents = {name: self.contents[name] for name in setup.FILES}
        contents[setup.FILES[-1]] = b"corrupted late archive member"
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.run_setup(lambda *_args, **_kwargs: io.BytesIO(archive_for(contents)))
        self.assertEqual(before, {name: self.asset_path(name).read_bytes() for name in setup.FILES})
        self.assertFalse(any(path.name.startswith("mediapipe-") for path in self.web.iterdir()))

    def test_verified_package_repairs_corrupt_runtime(self):
        name = setup.FILES[0]
        self.asset_path(name).write_bytes(b"corrupt")
        contents = {key: self.contents[key] for key in setup.FILES}
        download = self.run_setup(lambda *_args, **_kwargs: io.BytesIO(archive_for(contents)))
        self.assertEqual(download.call_count, 1)
        self.assertTrue(all(setup.valid(self.asset_path(key), key) for key in self.contents))

    def test_start_rejects_each_missing_or_empty_required_asset_before_binding(self):
        for asset in setup.REQUIRED_ASSETS:
            path = self.web / asset
            data = path.read_bytes()
            for absent in (True, False):
                with self.subTest(asset=asset, absent=absent):
                    if absent:
                        path.unlink()
                    else:
                        path.write_bytes(b"")
                    with patch.object(start, "__file__", str(self.root / "start.py")), \
                            patch.object(sys, "argv", ["start.py", "--no-browser"]), \
                            patch.object(start, "ThreadingHTTPServer") as server, \
                            patch("sys.stderr", new_callable=io.StringIO) as stderr:
                        with self.assertRaises(SystemExit) as raised:
                            start.main()
                    self.assertEqual(raised.exception.code, 1)
                    self.assertIn(asset, stderr.getvalue())
                    server.assert_not_called()
                    path.write_bytes(data)


if __name__ == "__main__":
    unittest.main()
