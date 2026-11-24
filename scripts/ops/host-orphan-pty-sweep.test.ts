import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('candidate inventory does not equate an old process or orphan shell with authority to signal it', () => {
  const modulePath = join(import.meta.dir, 'host-orphan-pty-sweep.py');
  const py = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('sweep',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
lines=['41 1 501 01-00:00:00 Z ?? old', '42 1 501 01-00:00:00 S ttys012 -zsh', '43 1 501 00:02:00 S ?? herdr', '44 1 501 01-00:00:00 S ?? herdr', '45 1 501 01-99:00:00 Z ?? bad']
print(json.dumps([m.classify(x) for x in lines]))`;
  const run = spawnSync('python3', ['-c', py, modulePath], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const rows = JSON.parse(run.stdout);
  expect(rows[0]).toMatchObject({ kinds: ['zombie_24h'], eligibleForSignal: false });
  expect(rows[1]).toMatchObject({ kinds: ['orphan_shell_candidate'], tabMembership: 'unverified', eligibleForSignal: false });
  expect(rows[2]).toBeNull();
  expect(rows[3]).toMatchObject({ kinds: ['retired_runtime_candidate'], eligibleForSignal: false });
  expect(rows[4]).toBeNull();
});
