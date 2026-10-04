import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDocs = join(import.meta.dir, '..', 'release', 'public', 'docs');
const manual = readFileSync(join(publicDocs, 'hq-failover.md'), 'utf8');
const fleetManual = readFileSync(join(publicDocs, 'multi-machine.md'), 'utf8');

const headings = [
  'Know which machine owns what',
  'Prepare both hosts before moving anything',
  'Establish and inspect the HQ lease',
  'Keep the holder and arbiter checking',
  'Fence every single-writer action',
  'Send snapshots from the current holder',
  'Verify the received copy, not just the send log',
  'Promote a verified standby',
  'Return to the former HQ without losing new writes',
  'Keep decisions moving while human seats are away',
  'What a real drill measured',
  'Diagnose a stalled or unsafe move',
];

describe('public HQ failover manual', () => {
  test('has twelve ordered operator topics and distinguishes the fleet control seat', () => {
    const actual = [...manual.matchAll(/^## (\d+)\. (.+)$/gm)].map(match => [Number(match[1]), match[2]]);
    expect(actual).toEqual(headings.map((heading, index) => [index + 1, heading]));
    expect(manual).toContain('[Running elanous on several machines](multi-machine.md)');
    expect(manual).toContain('**HQ** is a different job');
  });

  test('requires both unreachable views twice before automatic promotion', () => {
    expect(manual).toMatch(/two consecutive checks in which the arbiter cannot reach the holder \*\*and\*\* the standby has a fresh report/);
    expect(manual).toContain('One dual-unreachable check alone does not promote; a stale standby report or a reachable holder resets the streak');
    expect(manual).toContain('Failure of only one of the two probes still counts the holder as reachable');
    expect(manual).toContain('do **not** claim the lease by editing its file');
  });

  test('verifies snapshots before moving either way and keeps unfenced writers off', () => {
    expect(manual).toContain('bun scripts/hq/standby-verify.ts --root ~/.elanous-standby');
    expect(manual).toContain('core=30,big=400');
    expect(manual).toContain('A denied fenced command prints `hq fence: skip …` and exits **0** without running the child');
    expect(manual).toContain('its replication wrapper sends `core` and `big` **back** to the former holder');
    expect(manual).toContain('bun scripts/hq/standby-promote.ts --standby ~/.elanous-standby');
    expect(manual).toContain('--to ~/.elanous-hqstate --hq-config ~/.elanous-hqcfg --dry-run');
    expect(manual).toContain('The script refuses an existing target');
    expect(manual).toContain('leaves Telegram and Discord pollers disabled');
    expect(manual).toContain('Do not copy the old host\'s `hq.hostName`');
  });

  test('planned move and return both send and verify final core and big after writes drain but before lease release', () => {
    const section = (n: number) => manual.split(new RegExp(`^## ${n}\\. `, 'm'))[1].split(/^## /m)[0];
    const planned = section(8).split('For an unplanned outage')[0];
    const returning = section(9);
    for (const [text, stop, finalCopy, check, release] of [
      [planned, 'Wait for already-running writes', 'After the last write has finished', 'On the **replacement**, run the receiver verifier', 'elanous hq lease release'],
      [returning, 'wait for all in-flight writes', '**After the last write**', 'On the **former HQ**, run section 7\'s receiver verifier', 'does the current holder release its lease'],
    ]) {
      expect(text.indexOf(stop)).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(finalCopy)).toBeGreaterThan(text.indexOf(stop));
      expect(text.indexOf('`core` **and** `big`', text.indexOf(finalCopy))).toBeGreaterThan(text.indexOf(finalCopy));
      expect(text.indexOf(check)).toBeGreaterThan(text.indexOf(finalCopy));
      expect(text.indexOf('generation IDs', text.indexOf(check))).toBeGreaterThan(text.indexOf(check));
      expect(text.indexOf(release)).toBeGreaterThan(text.indexOf(check));
    }
  });

  test('planned move promotes the checked final generations and switches service paths before releasing the old lease', () => {
    const planned = manual.split(/^## 8\. /m)[1].split('For an unplanned outage')[0];
    const receiverCheck = planned.indexOf('On the **replacement**, run the receiver verifier');
    const promotion = planned.indexOf('bun scripts/hq/standby-promote.ts --standby ~/.elanous-standby');
    const generationCheck = planned.indexOf('Check the `promoted` output lists the *same final* `core` and `big` generation IDs');
    const serviceSwitch = planned.indexOf('update their **state directory** to the promoted target');
    const serviceCheck = planned.indexOf('Inspect the actual service definitions and effective paths');
    const release = planned.indexOf('elanous hq lease release');
    expect(receiverCheck).toBeGreaterThanOrEqual(0);
    expect(promotion).toBeGreaterThan(receiverCheck);
    expect(generationCheck).toBeGreaterThan(promotion);
    expect(serviceSwitch).toBeGreaterThan(generationCheck);
    expect(serviceCheck).toBeGreaterThan(serviceSwitch);
    expect(release).toBeGreaterThan(serviceCheck);
    expect(planned).toContain('including the daemon, channel launchers and cron jobs via `ELANOUS_STATE_DIR`, and the replication wrapper via `HQ_REP_STATE_DIR`');
    expect(planned).toContain('none of them will read the replacement\'s old `~/.elanous` or the received `~/.elanous-standby/`');
    expect(planned).toContain('Do not start writers yet');
  });

  test('preserves the fleet guide as the independent seat setup, rather than replacing its commands', () => {
    expect(fleetManual).toContain('elanous machine set --id home --duty workstation --seat control:1');
    expect(fleetManual).toContain('elanous role handoff --to studio');
    expect(fleetManual).toContain('elanous control serve --follow-lease');
  });
});
