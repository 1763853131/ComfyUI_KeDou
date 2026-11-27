"""连接策略回归：插件只做 sidecar 状态，不提供令牌鉴权契约。"""

import importlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_state():
    name = "_kedou_bridge_connection_tests"
    package = ModuleType(name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    with patch.dict(sys.modules, {
        name: package, "aiohttp": None, "server": None,
        "nodes": None, "folder_paths": None, "torch": None,
    }):
        return importlib.import_module(name + ".state")


class BridgeConnectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = load_state()

    def test_plugin_exposes_no_token_auth_contract(self):
        for name in ("_bridge_token_file", "_get_bridge_token", "_write_allowed"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(self.state, name))

    def test_sidecar_state_round_trip_still_works(self):
        with TemporaryDirectory(prefix="kedou_connection_state_") as tmp:
            app_path = str(Path(tmp) / "demo.kapp.json")
            with patch.object(self.state.paths, "_user_default_dir", return_value=tmp):
                self.assertEqual(self.state._load_app_state(app_path), {})
                self.state._save_app_state(app_path, {"steps": 20})
                self.assertEqual(self.state._load_app_state(app_path), {"steps": 20})


if __name__ == "__main__":
    unittest.main(verbosity=2)
