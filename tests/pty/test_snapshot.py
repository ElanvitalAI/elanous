import fcntl
import json
import os
from pathlib import Path
import struct
import tempfile
import termios
import unittest
from unittest.mock import patch

from src.pty.snapshot import restore, snapshot


class SnapshotPtyTest(unittest.TestCase):
    def test_snapshot_roundtrip_pty_dee629e3(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"ELANOUS_PTY_SNAPSHOT_DIR": directory}
        ):
            master, slave = os.openpty()
            try:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 104, 0, 0))
                attrs = termios.tcgetattr(slave)
                attrs[1] &= ~termios.OPOST
                termios.tcsetattr(slave, termios.TCSANOW, attrs)
                expected_attrs = termios.tcgetattr(master)
                os.write(slave, "화면 snapshot ✓\n".encode("utf-8"))

                saved = snapshot(master, "pty_dee629e3")
                self.assertEqual(saved.snapshot_id, "pty_dee629e3")
                self.assertEqual((saved.rows, saved.cols), (32, 104))
                self.assertEqual(saved.termios_attributes, expected_attrs)
                self.assertEqual(saved.output, "화면 snapshot ✓\n")

                stored = json.loads((Path(directory) / "pty_dee629e3.json").read_text())
                self.assertEqual(stored["snapshot_id"], "pty_dee629e3")

                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                replay = restore("pty_dee629e3")
                self.assertEqual(replay.snapshot, saved)
                self.assertEqual((replay.live_rows, replay.live_cols), (40, 120))
                self.assertFalse(replay.matches_live)

                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 104, 0, 0))
                self.assertTrue(restore("pty_dee629e3").matches_live)
            finally:
                os.close(master)
                os.close(slave)

    def test_default_id_is_stable(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"ELANOUS_PTY_SNAPSHOT_DIR": directory}
        ):
            master, slave = os.openpty()
            try:
                saved = snapshot(master)
                self.assertEqual(saved.snapshot_id, "pty_dee629e3")
                self.assertEqual(restore().snapshot, saved)
            finally:
                os.close(master)
                os.close(slave)

    def test_restore_rejects_tampered_id_and_schema(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"ELANOUS_PTY_SNAPSHOT_DIR": directory}
        ):
            master, slave = os.openpty()
            try:
                snapshot(master, "pty_dee629e3")
                path = Path(directory) / "pty_dee629e3.json"
                payload = json.loads(path.read_text())
                payload["snapshot_id"] = "different"
                path.write_text(json.dumps(payload))
                with self.assertRaises(ValueError):
                    restore("pty_dee629e3")
                del payload["rows"]
                path.write_text(json.dumps(payload))
                with self.assertRaises(ValueError):
                    restore("pty_dee629e3")
                payload["rows"] = 32
                payload["snapshot_id"] = "pty_dee629e3"
                payload["schema"] = -1
                path.write_text(json.dumps(payload))
                with self.assertRaises(ValueError):
                    restore("pty_dee629e3")
            finally:
                os.close(master)
                os.close(slave)


if __name__ == "__main__":
    unittest.main()
