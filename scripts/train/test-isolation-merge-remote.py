import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

path = pathlib.Path(__file__).with_name('isolation-merge-remote.py')
spec = importlib.util.spec_from_file_location('isolation_remote', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class DecisionTests(unittest.TestCase):
    def test_success_and_baseline(self):
        self.assertEqual(mod.evaluate(0, '', 0, '')[0], 0)
        self.assertEqual(mod.evaluate(1, '  src/a.ts → one', 1, '  src/a.ts → one')[0], 0)
        self.assertEqual(mod.evaluate(1, '  src/a.ts → one\n  src/b.ts → two', 1, '  src/a.ts → one')[0], 1)
        self.assertEqual(mod.evaluate(1, '', 1, '')[0], 2)
        self.assertEqual(mod.evaluate(1, '  src/a.ts → one', 0, '')[0], 1)
        self.assertEqual(mod.evaluate(255, '', 1, '  src/a.ts → one')[0], 2)
        self.assertEqual(mod.evaluate(1, '  src/a.ts → one', 255, '')[0], 2)

    def test_refuses_untrusted_identity_before_any_io(self):
        for host, head, base in [('evil', 'a'*40, 'b'*40), ('node-b', 'a'*39, 'b'*40), ('node-b', 'a'*40, 'b'*39 + ';')]:
            with self.assertRaises(ValueError): mod.run('/tmp/x', host, head, base)

    def test_untrusted_gate_and_symlink_never_reach_ssh(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            def git(*args):
                return subprocess.run(['git', '-C', d, *args], check=True, capture_output=True, text=True).stdout.strip()
            git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test')
            (root/'src').mkdir(); (root/'scripts').mkdir()
            (root/'src'/'file.ts').write_text('export {}\n')
            gate = root/'scripts'/'ci-isolation-hardcode-gate.ts'; gate.write_text('trusted\n')
            (root/'scripts'/'isolation-hardcode-baseline.txt').write_text('baseline\n')
            git('add', '.'); git('commit', '-qm', 'base'); base = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/remotes/origin/main', base)
            gate.write_text('untrusted\n'); git('add', '.'); git('commit', '-qm', 'gate change'); head = git('rev-parse', 'HEAD')
            with self.assertRaisesRegex(RuntimeError, 'gate script or baseline changed'): mod.run(d, 'node-b', head, base)
            git('reset', '--hard', base); (root/'src'/'link.ts').symlink_to('/tmp/anything')
            git('add', '.'); git('commit', '-qm', 'symlink'); head = git('rev-parse', 'HEAD')
            with self.assertRaisesRegex(RuntimeError, 'symlink or non-file'): mod.run(d, 'node-b', head, base)

if __name__ == '__main__': unittest.main()
