import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLandDeps, finisherDeps, readReceipt } from '../cli/land-graph-cli.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import type { PrInfo } from './land-graph.js';

test('isolated launcher runs fake pregate and reads success and failure receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'land-launch-fixture-'));
  const seats = join(root, 'seats');
  const tool = join(seats, 'RES', 'tools', 'pregate');
  mkdirSync(join(seats, 'RES', 'tools'), { recursive: true });
  writeFileSync(tool, `#!/bin/sh\nset -eu\npr="$1"\n[ "$2" = '--light' ]\nmkdir -p "$FIXTURE_OUT/$pr"\nprintf '{"head":"%s","host":"fixture","steps":[{"name":"focused","exit":%s}]}' "$FIXTURE_HEAD" "$FIXTURE_EXIT" > "$FIXTURE_OUT/$pr/receipt.json"\nprintf 'fixture pr=%s mode=%s\\n' "$pr" "$2"\n`);
  const saved = { ...process.env };
  try {
    process.env.ELANOUS_SEAT_STATE = seats;
    // A stale-head receipt triggers git ancestry/fetch checks. Never use the real
    // repository or network in this fixture; every ancestry check fails closed.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
    process.env.GH_REPO = 'fixture/isolated';
    process.env.FIXTURE_OUT = join(root, 'output');
    setElanousConfigDir(join(root, 'instance'));
    const head = 'a'.repeat(40);
    const deps = finisherDeps({ slug: '' } as Parameters<typeof finisherDeps>[0], root);
    for (const exit of [0, 1]) {
      const number = 8100 + exit;
      process.env.FIXTURE_HEAD = head;
      process.env.FIXTURE_EXIT = String(exit);
      const pr = { number, head } as PrInfo;
      const launched = deps.launchPregate(pr);
      expect(launched.ok).toBe(true);
      const receiptDir = join(root, 'output', String(number));
      const until = Date.now() + 15000;
      while (!existsSync(join(receiptDir, 'receipt.json')) && Date.now() < until) await Bun.sleep(20);
      const receipt = readReceipt(receiptDir, { red: exit !== 0 });
      expect(receipt?.head).toBe(head);
      expect(receipt?.focusedExit).toBe(exit);
      if (!launched.ok) throw new Error('launcher failed');
      expect(readFileSync(launched.log!, 'utf8')).toContain(`fixture pr=${number} mode=--light`);
    }
    // A filename matching the requested head must not make a different-head receipt valid.
    const wrongDir = join(seats, 'RES', 'evidence', 'PREGATE-GREEN', `8200-${head.slice(0, 12)}-fixture`);
    mkdirSync(wrongDir, { recursive: true });
    writeFileSync(join(wrongDir, 'receipt.json'), JSON.stringify({ pr: 8200, head: 'b'.repeat(40), host: 'fixture', steps: [{ name: 'focused', exit: 0 }] }));
    expect(readReceipt(wrongDir)?.head).toBe('b'.repeat(40));
    expect(defaultLandDeps().receipt(8200, head)).toBeNull();
    // A forged directory name must not override the PR in the receipt body.
    const wrongPrDir = join(seats, 'RES', 'evidence', 'PREGATE-GREEN', `8201-${head.slice(0, 12)}-fixture`);
    mkdirSync(wrongPrDir, { recursive: true });
    writeFileSync(join(wrongPrDir, 'receipt.json'), JSON.stringify({ pr: 9999, head, host: 'fixture', steps: [{ name: 'focused', exit: 0 }] }));
    expect(defaultLandDeps().receipt(8201, head)).toBeNull();
    writeFileSync(join(wrongPrDir, 'receipt.json'), JSON.stringify({ pr: 8201, head, host: 'fixture', steps: [{ name: 'focused', exit: 0 }] }));
    expect(defaultLandDeps().receipt(8201, head)?.head).toBe(head);
  } finally {
    resetElanousConfigDir();
    for (const name of ['ELANOUS_SEAT_STATE', 'GH_REPO', 'PATH', 'FIXTURE_OUT', 'FIXTURE_HEAD', 'FIXTURE_EXIT']) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}, 45000);
