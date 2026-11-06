"""Offline distribution and loopback launcher regressions; no network downloads."""
from contextlib import contextmanager
from functools import partial
from http.client import HTTPConnection
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
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
# Captured before any test patches it.
DEFAULT_ONECLICK_OUTPUT = oneclick.OUTPUT


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


def request(port, method, path, body=None):
    """One loopback request, bypassing any proxy the machine may have configured."""
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


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
        # These tests exercise the static server only; do not create a database.
        self.start_api = patch.object(launcher, "start_api", return_value=None)
        self.start_api.start()
        self.addCleanup(self.start_api.stop)

    def prepare_assets(self):
        for name in launcher.REQUIRED + ["index.html"]:
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


class LauncherPathTests(unittest.TestCase):
    """--path picks the page the browser opens; the default stays the personal game at /."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.web = Path(self.temporary.name) / "web"
        self.start_api = patch.object(launcher, "start_api", return_value=None)
        self.start_api.start()
        self.addCleanup(self.start_api.stop)
        for name in launcher.REQUIRED + ["index.html", "stage.html", "perf-lab.html"]:
            path = self.web / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"resource")

    def launch(self, argv):
        server = unittest.mock.Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with patch.object(launcher, "WEB", self.web), \
                patch.object(launcher, "acquire_server", return_value=(server, 8787)), \
                patch.object(launcher.threading, "Timer") as timer, \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            code = launcher.main(argv)
        with patch.object(launcher.webbrowser, "open") as opened:
            timer.call_args.args[1]()
        return code, opened, output.getvalue()

    def test_default_opens_the_site_root(self):
        code, opened, _ = self.launch([])
        self.assertEqual(code, 0)
        opened.assert_called_once_with("http://localhost:8787")

    def test_path_opens_that_page_and_prints_its_full_address(self):
        for argv, url in ((["--path", "/stage.html"], "http://localhost:8787/stage.html"),
                          (["--path", "perf-lab.html"], "http://localhost:8787/perf-lab.html"),
                          (["--path", "/perf-lab.html?scene=island"], "http://localhost:8787/perf-lab.html?scene=island")):
            with self.subTest(argv=argv):
                code, opened, output = self.launch(argv)
                self.assertEqual(code, 0)
                opened.assert_called_once_with(url)
                self.assertIn(url, output)

    def test_reusing_a_running_launcher_still_opens_the_requested_page(self):
        with patch.object(launcher, "WEB", self.web), \
                patch.object(launcher, "acquire_server", return_value=(None, 8788)), \
                patch.object(launcher.webbrowser, "open") as opened, \
                patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(launcher.main(["--path", "/stage.html"]), 0)
        opened.assert_called_once_with("http://localhost:8788/stage.html")

    def test_missing_page_stops_before_starting_a_server(self):
        (self.web / "stage.html").unlink()
        with patch.object(launcher, "WEB", self.web), \
                patch.object(launcher, "acquire_server") as acquire, \
                patch.object(launcher.webbrowser, "open") as opened, \
                patch("builtins.input", return_value=""), \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(launcher.main(["--path", "/stage.html"]), 1)
        acquire.assert_not_called()
        opened.assert_not_called()
        self.assertIn("web/stage.html", output.getvalue())

    def test_path_cannot_point_outside_the_local_server(self):
        for raw in ("//evil.example/x", "http://evil.example/", "/../secret.txt", "/a\\b.html", "/a b.html", "/x\n.html"):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    launcher.page_target(raw)
                with patch.object(launcher, "WEB", self.web), \
                        patch.object(launcher, "acquire_server") as acquire, \
                        patch("sys.stdout", new_callable=io.StringIO) as output:
                    self.assertEqual(launcher.main(["--path", raw]), 2)
                acquire.assert_not_called()
                self.assertIn("--path", output.getvalue())
        self.assertEqual(launcher.page_target("/"), ("/", "index.html"))
        self.assertEqual(launcher.page_target("stage.html"), ("/stage.html", "stage.html"))


class RecordingApi:
    """Stands in for the account App: records what the launcher forwarded to it."""

    def __init__(self):
        self.calls = []

    def handle(self, method, path, headers, body, client_ip):
        self.calls.append((method, urlsplit(path).path))
        return 200, [("Content-Type", "application/json; charset=utf-8")], b'{"service":"ok"}'


class LauncherApiTests(unittest.TestCase):
    """/api/v1/ belongs to the embedded account server; every other path stays static."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.web = Path(self.temporary.name) / "web"
        self.web.mkdir()
        (self.web / "index.html").write_bytes(b"static page")
        patcher = patch.object(launcher.Handler, "api", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_only_api_paths_reach_the_account_server(self):
        api = RecordingApi()
        with patch.object(launcher.Handler, "api", api), serving(self.web) as port:
            status, headers, body = request(port, "GET", "/api/v1/health?probe=1")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "application/json; charset=utf-8")
        self.assertEqual(json.loads(body), {"service": "ok"})
        self.assertEqual(api.calls, [("GET", "/api/v1/health")])
        with patch.object(launcher.Handler, "api", api), serving(self.web) as port:
            status, _, body = request(port, "GET", "/index.html")
        self.assertEqual((status, body), (200, b"static page"))
        self.assertEqual(api.calls, [("GET", "/api/v1/health")], "static pages must stay static")

    def test_request_without_a_started_account_server_is_a_503_json(self):
        with serving(self.web) as port:
            for method, path in (("GET", "/api/v1/health"), ("POST", "/api/v1/auth/login"),
                                 ("DELETE", "/api/v1/me"), ("HEAD", "/api/v1/leaderboard")):
                with self.subTest(method=method):
                    body = b"{}" if method in ("POST", "DELETE") else None
                    status, headers, payload = request(port, method, path, body)
                    self.assertEqual(status, 503)
                    self.assertEqual(headers.get("Content-Type"), "application/json; charset=utf-8")
                    if method == "HEAD":
                        self.assertEqual(payload, b"")
                    else:
                        self.assertEqual(json.loads(payload)["error"]["code"], "server")


class LauncherDatabaseTests(unittest.TestCase):
    """The account database lives in the package folder, or in the user profile if that is read-only."""

    def test_writable_package_folder_is_used_as_is(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "package/data/movecraft.sqlite3"
            with patch.object(launcher, "DB_PATH", database):
                self.assertEqual(launcher.database_path(), database)
            self.assertTrue(database.parent.is_dir(), "the package data folder must be created")

    def test_unwritable_package_folder_falls_back_to_local_appdata(self):
        original = Path.mkdir
        with tempfile.TemporaryDirectory() as temporary:
            package_data = Path(temporary) / "package/data"
            database = package_data / "movecraft.sqlite3"
            local = Path(temporary) / "LocalAppData"

            def mkdir(path, *args, **kwargs):
                if Path(path) == package_data:
                    raise OSError(13, "package folder is read-only")
                return original(path, *args, **kwargs)

            with patch.object(launcher, "DB_PATH", database), \
                    patch.object(launcher.Path, "mkdir", mkdir), \
                    patch.dict(os.environ, {"LOCALAPPDATA": str(local)}):
                expected = local / "MoveCraft" / "movecraft.sqlite3"
                self.assertEqual(launcher.database_path(), expected)
            self.assertTrue(expected.parent.is_dir())
            self.assertFalse(package_data.exists())


class ShortcutTests(unittest.TestCase):
    """The .bat files must run on Chinese Windows, whose console starts in GBK (code page 936)."""
    SHORTCUTS = {"大屏模式.bat": "/stage.html", "性能测试.bat": "/perf-lab.html"}

    def test_every_bat_switches_to_utf8_before_any_chinese_text(self):
        for name in ["双击启动游戏.bat", *self.SHORTCUTS]:
            with self.subTest(name=name):
                data = (ROOT / "launcher" / name).read_bytes()
                self.assertFalse(data.startswith(b"\xef\xbb\xbf"), "a BOM breaks the first command")
                head, separator, _ = data.partition(b"chcp 65001")
                self.assertTrue(separator, "missing chcp 65001")
                self.assertTrue(all(byte < 128 for byte in head), "only ASCII may come before chcp 65001")
                data.decode("utf-8")

    def test_new_shortcuts_use_crlf_and_open_their_page(self):
        for name, path in self.SHORTCUTS.items():
            with self.subTest(name=name):
                data = (ROOT / "launcher" / name).read_bytes()
                self.assertEqual(data.count(b"\n"), data.count(b"\r\n"), "cmd.exe expects CRLF line endings")
                text = data.decode("utf-8")
                self.assertIn('"runtime\\python.exe" start_game.py --path ' + path, text)
                self.assertIn('if not exist "web\\' + path.lstrip("/") + '"', text)
                self.assertEqual(launcher.page_target(path), (path, path.lstrip("/")))


class OneClickOutputTests(unittest.TestCase):
    """Optional output path; both shortcuts are packed; the default output is unchanged."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = self.root = Path(self.temporary.name)
        (root / "runtime").mkdir()
        (root / "runtime/python.exe").write_bytes(b"runtime")
        for name in package.ASSETS + ["index.html", "stage.html"]:
            path = root / "web" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"resource")
        (root / "launcher/__pycache__").mkdir(parents=True)
        (root / "launcher/__pycache__/start_game.pyc").write_bytes(b"cache")
        for name in oneclick.LAUNCHER_FILES:
            (root / "launcher" / name).write_bytes(b"launcher")
        (root / "server").mkdir()
        for name in ("__init__.py", "app.py", "serve.py"):
            (root / "server" / name).write_bytes(b"server")
        (root / "server/tests").mkdir()
        (root / "server/tests/test_app.py").write_bytes(b"server test")
        (root / "server/__pycache__").mkdir()
        (root / "server/__pycache__/app.pyc").write_bytes(b"cache")
        self.default = root / "deliverables/movecraft-island-oneclick.zip"
        for name, value in (("ROOT", root), ("RUNTIME", root / "runtime"), ("WEB", root / "web"),
                            ("LAUNCHER", root / "launcher"), ("SERVER", root / "server"),
                            ("OUTPUT", self.default)):
            patcher = patch.object(oneclick, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def build(self, argv):
        with patch("sys.stdout", new_callable=io.StringIO):
            return oneclick.main(argv)

    def test_default_output_is_unchanged(self):
        self.assertEqual(DEFAULT_ONECLICK_OUTPUT, ROOT / "deliverables/movecraft-island-oneclick.zip")
        self.assertEqual(self.build([]), self.default)
        with ZipFile(self.default) as archive:
            names = set(archive.namelist())
        folder = oneclick.FOLDER + "/"
        expected = {folder + name for name in ("双击启动游戏.bat", "大屏模式.bat", "性能测试.bat", "start_game.py", "README-一键版.txt",
                                                "web/stage.html", "runtime/python.exe")}
        self.assertTrue(expected <= names, expected - names)
        self.assertFalse(any("__pycache__" in name for name in names))

    def test_optional_output_path_writes_only_there(self):
        target = self.root / "out/nested/perf-test.zip"
        self.assertEqual(self.build([str(target)]), target)
        self.assertTrue(target.is_file())
        self.assertFalse(self.default.exists())
        with ZipFile(target) as archive:
            self.assertIn(oneclick.FOLDER + "/性能测试.bat", archive.namelist())
        self.assertEqual([path.name for path in target.parent.iterdir()], ["perf-test.zip"])

    def test_output_inside_a_packed_folder_is_refused(self):
        with self.assertRaisesRegex(SystemExit, "must not be inside"):
            self.build([str(self.root / "web/package.zip")])
        self.assertFalse((self.root / "web/package.zip").exists())

    def test_missing_shortcut_keeps_the_previous_package(self):
        self.default.parent.mkdir()
        self.default.write_bytes(b"previous package")
        (self.root / "launcher/大屏模式.bat").unlink()
        with self.assertRaisesRegex(SystemExit, "大屏模式.bat"):
            self.build([])
        self.assertEqual(self.default.read_bytes(), b"previous package")

    def test_write_failure_keeps_the_previous_package(self):
        self.default.parent.mkdir()
        self.default.write_bytes(b"previous package")
        with patch.object(oneclick, "ZipFile", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.build([])
        self.assertEqual(self.default.read_bytes(), b"previous package")
        self.assertEqual(list(self.default.parent.iterdir()), [self.default])

    def test_embedded_account_server_ships_without_its_tests_or_caches(self):
        self.build([])
        with ZipFile(self.default) as archive:
            names = set(archive.namelist())
        folder = oneclick.FOLDER + "/server/"
        self.assertTrue({folder + name for name in ("__init__.py", "app.py", "serve.py")} <= names)
        self.assertEqual([name for name in names
                          if "__pycache__" in name or name.startswith(folder + "tests/")], [],
                         "the launcher imports server/, so its tests and caches must not ship")

    def test_missing_account_server_stops_the_build_with_a_clear_error(self):
        self.default.parent.mkdir()
        self.default.write_bytes(b"previous package")
        (self.root / "server/app.py").unlink()
        with self.assertRaisesRegex(SystemExit, r"Account server file missing: .*server/app\.py"):
            self.build([])
        self.assertEqual(self.default.read_bytes(), b"previous package")


if __name__ == "__main__":
    unittest.main()
