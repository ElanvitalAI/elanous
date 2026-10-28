import { expect, test } from 'bun:test';

// Keep the real openpty integration checks in the requested Python test file.
test('Python PTY snapshot integration', () => {
  const result = Bun.spawnSync(
    ['python3', '-m', 'unittest', 'discover', '-s', 'tests/pty', '-p', 'test_snapshot.py', '-v'],
    { cwd: import.meta.dir + '/../..', stdout: 'pipe', stderr: 'pipe' },
  );
  const output = new TextDecoder().decode(result.stderr);
  expect(result.exitCode, output).toBe(0);
  expect(output, 'Python tests must actually run').toContain('Ran 3 tests');
  console.log(output.match(/^Ran 3 tests in .*$/m)?.[0]);
});
