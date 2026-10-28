import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateShardAbortScript, gateShardShell } from './gate-node';

setDefaultTimeout(15_000);

test('GATE-POD-STALL-FAILFAST-FU: gate shell aborts only the same PID/starttime/PGID and records the stopped part', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-abort-identity-'));
  const proc = join(root, 'proc');
  const outbox = join(root, 'outbox');
  const bin = join(root, 'bin');
  mkdirSync(join(proc, '1'), { recursive: true });
  mkdirSync(join(proc, '123'));
  mkdirSync(outbox);
  mkdirSync(bin);
  const stat = (pid: number, pgid: number, start: number) => `${pid} (timeout test) S 1 ${pgid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start}\n`;
  writeFileSync(join(proc, '1', 'stat'), stat(1, 1, 100));
  writeFileSync(join(proc, '1', 'cmdline'), '');
  writeFileSync(join(proc, '123', 'stat'), stat(123, 123, 456));
  writeFileSync(join(proc, '123', 'cmdline'), `timeout\0--reporter-outfile=${outbox}/part-0.junit.xml\0`);
  const signals = join(root, 'signals');
  const run = (reuseBetweenSnapshotAndSignal: boolean, reuseAfterTerm = false, failTerm = false) => {
    // The injected proc root makes the generated Pod-side script executable in a hermetic fixture.
    const scriptBody = `kill() { printf '%s\\n' "$*" >> ${JSON.stringify(signals)}; if [ "$1" = -TERM ] && [ "$REUSE_PID_AFTER_TERM" = 1 ]; then printf '%s' '${stat(123, 123, 999).trim()}' > ${JSON.stringify(join(proc, '123', 'stat'))}; fi; if [ "$1" = -TERM ] && [ "$FAIL_TERM" = 1 ]; then return 1; fi; return 0; }\n${gateShardAbortScript('mid-run-stall 3s', 1, outbox).replaceAll('/proc/', `${proc}/`)}`;
    if (reuseBetweenSnapshotAndSignal) {
      const realSed = spawnSync('bash', ['-lc', 'command -v sed'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(bin, 'sed'), `#!/bin/sh\n"${realSed}" "$@"\nrc=$?\ncase "$*" in *${proc}/123/stat*) if [ ! -e ${JSON.stringify(join(root, 'reused'))} ]; then touch ${JSON.stringify(join(root, 'reused'))}; printf '%s' '${stat(123, 123, 999).trim()}' > ${JSON.stringify(join(proc, '123', 'stat'))}; fi;; esac\nexit $rc\n`);
      chmodSync(join(bin, 'sed'), 0o755);
    }
    const waitForGrace = scriptBody.replace('[ "$found" -gt 0 ]', '[ "$found" -gt 0 ]; result=$?; wait; exit $result');
    return spawnSync('bash', ['-c', waitForGrace], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REUSE_PID_AFTER_TERM: reuseAfterTerm ? '1' : '0', FAIL_TERM: failTerm ? '1' : '0' } });
  };
  try {
    const connectedShell = gateShardShell({ parts: [['src/example.test.ts']], cdpPatterns: [], softSeconds: 30, cachePrefix: '', installSlots: 0 });
    expect(connectedShell).toContain('timeout -k 10');
    expect(connectedShell).toContain('part-$i.junit.xml');
    const stale = run(true);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain('ELANOUS_GATE_ABORT signalled=0');
    expect(existsSync(join(outbox, 'part-0.abort'))).toBe(false);
    expect(existsSync(signals)).toBe(false);

    writeFileSync(join(proc, '123', 'stat'), stat(123, 123, 456));
    rmSync(join(root, 'reused'), { force: true });
    rmSync(join(bin, 'sed'), { force: true });
    const live = run(false);
    expect(live.status).toBe(0);
    expect(live.stdout).toContain('ELANOUS_GATE_ABORT part=0 pgid=123');
    expect(live.stdout).toContain('ELANOUS_GATE_ABORT signalled=1');
    expect(readFileSync(join(outbox, 'part-0.abort'), 'utf8')).toBe('mid-run-stall 3s\n');
    expect(readFileSync(join(outbox, 'shard.timeout'), 'utf8')).toBe('0\n');
    expect(readFileSync(signals, 'utf8')).toContain('-TERM -- -123');
    expect(readFileSync(signals, 'utf8')).toContain('-KILL -- -123');

    writeFileSync(join(proc, '123', 'stat'), stat(123, 123, 456));
    rmSync(signals, { force: true });
    rmSync(join(outbox, 'part-0.abort'), { force: true });
    rmSync(join(outbox, 'shard.timeout'), { force: true });
    const rejectedTerm = run(false, false, true);
    expect(rejectedTerm.stdout).toContain('ELANOUS_GATE_ABORT signalled=0');
    expect(existsSync(join(outbox, 'part-0.abort'))).toBe(false);
    expect(existsSync(join(outbox, 'shard.timeout'))).toBe(false);

    writeFileSync(join(proc, '123', 'stat'), stat(123, 123, 456));
    rmSync(signals, { force: true });
    const reusedDuringGrace = run(false, true);
    expect(reusedDuringGrace.status).toBe(0);
    expect(readFileSync(signals, 'utf8')).toContain('-TERM -- -123');
    expect(readFileSync(signals, 'utf8')).not.toContain('-KILL -- -123');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
