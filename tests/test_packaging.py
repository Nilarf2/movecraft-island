"""Offline distribution and loopback launcher regressions; no network downloads."""
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parent.parent


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load_module("package_offline", "scripts/package_offline.py")
oneclick = load_module("package_oneclick", "scripts/package_oneclick.py")
launcher = load_module("start_game", "launcher/start_game.py")


@contextmanager
def serving(web, handler=launcher.Handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, directory=str(web)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class OfflinePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in package.DIRECTORIES:
            (self.root / name).mkdir()
        paths = package.FILES + ["launcher/" + name for name in package.LAUNCHER_FILES]
        paths += ["web/" + name for name in package.ASSETS]
        for name in paths:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"prepared resource")
        self.output = self.root / "deliverables/game.zip"

    def test_archive_includes_launcher_and_all_prepared_assets(self):
        cache = self.root / "launcher/__pycache__/start_game.pyc"
        cache.parent.mkdir()
        cache.write_bytes(b"cache")
        package.create_package(self.root, self.output)
        with ZipFile(self.output) as archive:
            names = set(archive.namelist())
        required = ["launcher/" + name for name in package.LAUNCHER_FILES]
        required += ["web/" + name for name in package.ASSETS]
        self.assertTrue({"movecraft-island/" + name for name in required} <= names)
        self.assertFalse(any("__pycache__" in name for name in names))

    def test_every_missing_runtime_asset_fails_before_creating_an_archive(self):
        for name in package.ASSETS:
            with self.subTest(name=name):
                path = self.root / "web" / name
                path.unlink()
                with self.assertRaisesRegex(ValueError, name.replace(".", r"\.")):
                    package.create_package(self.root, self.output)
                self.assertFalse(self.output.exists())
                path.write_bytes(b"restored resource")

    def test_empty_asset_and_missing_launcher_preserve_previous_archive(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b"previous complete archive")
        asset = self.root / "web" / package.ASSETS[-1]
        asset.write_bytes(b"")
        (self.root / "launcher/start_game.py").unlink()
        with self.assertRaises(ValueError) as error:
            package.create_package(self.root, self.output)
        self.assertIn("models/pose_landmarker_lite.task", str(error.exception))
        self.assertIn("launcher/start_game.py", str(error.exception))
        self.assertEqual(self.output.read_bytes(), b"previous complete archive")

    def test_write_failure_preserves_previous_archive_and_removes_staging_file(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b"previous complete archive")
        with patch.object(package, "ZipFile", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                package.create_package(self.root, self.output)
        self.assertEqual(self.output.read_bytes(), b"previous complete archive")
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])


class OneClickPackageTests(unittest.TestCase):
    def test_missing_or_empty_runtime_assets_preserve_previous_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "python.exe").write_bytes(b"runtime")
            web = root / "web"
            for name in package.ASSETS:
                path = web / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"resource")
            output = root / "game.zip"
            output.write_bytes(b"previous package")
            with patch.object(oneclick, "RUNTIME", runtime), patch.object(oneclick, "WEB", web), patch.object(oneclick, "OUTPUT", output):
                for name in package.ASSETS:
                    path = web / name
                    for bad_data in (None, b""):
                        with self.subTest(name=name, bad_data=bad_data):
                            if bad_data is None:
                                path.unlink()
                            else:
                                path.write_bytes(bad_data)
                            with self.assertRaisesRegex(SystemExit, "Game assets are missing"):
                                oneclick.main()
                            self.assertEqual(output.read_bytes(), b"previous package")
                            path.write_bytes(b"resource")


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.web = Path(self.temporary.name) / "web"
        self.web.mkdir()

    def prepare_assets(self):
        for name in launcher.REQUIRED:
            path = self.web / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"resource")

    def test_repeat_launch_reuses_same_root_even_if_an_earlier_port_is_free(self):
        with serving(self.web) as port:
            server, selected = launcher.acquire_server(self.web, [0, port])
            if server is not None:
                self.addCleanup(server.server_close)
            self.assertIsNone(server)
            self.assertEqual(selected, port)

    def test_other_installation_is_not_reused(self):
        other = self.web.parent / "other"
        other.mkdir()
        with serving(other) as port:
            self.assertFalse(launcher.is_same_instance(port, self.web))
            server, selected = launcher.acquire_server(self.web, [port, 0])
            self.assertIsNotNone(server)
            self.addCleanup(server.server_close)
            self.assertNotEqual(selected, port)

    def test_unrelated_http_service_is_not_reused(self):
        class QuietStaticHandler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        with serving(self.web, QuietStaticHandler) as port:
            self.assertFalse(launcher.is_same_instance(port, self.web))
            server, selected = launcher.acquire_server(self.web, [port, 0])
            self.assertIsNotNone(server)
            self.addCleanup(server.server_close)
            self.assertNotEqual(selected, port)

    def test_reuse_opens_original_browser_origin_without_starting_another_server(self):
        self.prepare_assets()
        with patch.object(launcher, "WEB", self.web), \
                patch.object(launcher, "acquire_server", return_value=(None, 8788)), \
                patch.object(launcher.webbrowser, "open") as opened, \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(launcher.main(), 0)
        opened.assert_called_once_with("http://localhost:8788")
        self.assertIn("同一文件夹", output.getvalue())
        self.assertIn("原地址", output.getvalue())

    def test_changed_port_explicitly_explains_browser_save_isolation(self):
        self.prepare_assets()
        server = unittest.mock.Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with patch.object(launcher, "WEB", self.web), \
                patch.object(launcher, "acquire_server", return_value=(server, 8788)), \
                patch.object(launcher.threading, "Timer"), \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(launcher.main(), 0)
        self.assertIn("http://localhost:8788", output.getvalue())
        self.assertIn("存档按地址和端口分别保存", output.getvalue())
        server.server_close.assert_called_once()

    def test_empty_asset_stops_launcher_before_opening_the_browser(self):
        self.prepare_assets()
        (self.web / launcher.REQUIRED[-1]).write_bytes(b"")
        with patch.object(launcher, "WEB", self.web), \
                patch.object(launcher, "acquire_server") as acquire, \
                patch.object(launcher.webbrowser, "open") as opened, \
                patch("builtins.input", return_value=""), \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(launcher.main(), 1)
        acquire.assert_not_called()
        opened.assert_not_called()
        self.assertIn("models/pose_landmarker_lite.task", output.getvalue())


if __name__ == "__main__":
    unittest.main()
