import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kedou_bridge import av_sets


def item(filename, tab="input", kind="video", **extra):
    value = {"filename": filename, "tab": tab, "kind": kind, "extract_audio": kind == "video" and tab == "audio"}
    value.update(extra)
    return value


class AVSetsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = os.path.join(self.tmp.name, "av_sets.json")
        self.patch = patch.object(av_sets, "_store_path", return_value=self.store)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_save_list_load_rename_delete(self):
        videos = [item("a.mp4"), item("b.mp4", trim_start=1, trim_end=2)]
        audios = [item("voice.wav", kind="audio")]
        saved = av_sets.save_set(
            "demo", videos, audios, batch=True, select=True,
            picked_videos=["input|b.mp4"], picked_audios=["input|voice.wav"],
            output_mode="frames", video_audio=True,
            frame_options={"start_frame": 0, "max_frames": 8, "frame_step": 1, "max_side": 512})
        self.assertTrue(saved["ok"])
        set_id = saved["item"]["id"]
        listed = av_sets.list_sets()
        self.assertEqual([entry["name"] for entry in listed["items"]], ["demo"])
        with patch.object(av_sets, "_find_media", return_value="exists"):
            loaded = av_sets.load_set(set_id)
        self.assertTrue(loaded["ok"])
        self.assertEqual([entry["filename"] for entry in loaded["item"]["videos"]], ["a.mp4", "b.mp4"])
        self.assertEqual(loaded["item"]["picked_videos"], ["input|b.mp4"])
        self.assertEqual(loaded["item"]["output_mode"], "frames")
        self.assertTrue(av_sets.rename_set(set_id, "renamed")["ok"])
        self.assertEqual(av_sets.list_sets()["items"][0]["name"], "renamed")
        self.assertTrue(av_sets.delete_set(set_id)["ok"])
        self.assertEqual(av_sets.list_sets()["items"], [])

    def test_load_reports_missing_and_filters_picks(self):
        saved = av_sets.save_set("missing", [item("a.mp4"), item("b.mp4")], [])
        set_id = saved["item"]["id"]
        with patch.object(av_sets, "_find_media", side_effect=["exists", None]):
            loaded = av_sets.load_set(set_id)
        self.assertEqual([entry["filename"] for entry in loaded["item"]["videos"]], ["a.mp4"])
        self.assertEqual(loaded["missing"], ["b.mp4"])

    def test_cap_always_keeps_the_item_being_saved(self):
        with patch.object(av_sets, "_now", return_value="2026-01-01 00:00:00"):
            for index in range(101):
                self.assertTrue(av_sets.save_set("p%03d" % index, [item("a.mp4")], [])["ok"])
        names = {entry["name"] for entry in av_sets.list_sets()["items"]}
        self.assertEqual(len(names), 100)
        self.assertIn("p100", names)
        self.assertNotIn("p000", names)

    def test_rejects_unsafe_or_empty_media(self):
        self.assertFalse(av_sets.save_set("bad", [item("../escape.mp4")], [])["ok"])
        self.assertFalse(av_sets.save_set("empty", [], [])["ok"])


if __name__ == "__main__":
    unittest.main()
