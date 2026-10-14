import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { ClaimsLedger } from '../claims/claims-ledger.js';
import { PatentLedger } from '../patents/ledger.js';
import { registerClaimsCommands } from './claims-cli.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'claims-patent-wiring-')));

test('default claims render preserves output and state; explicit opt-in reads public-allowed patents', () => {
  const stateDir = root();
  const instanceRoot = root();
  const now = new Date('2026-10-04T00:00:00Z');
  const lines: string[] = [];
  const program = new Command();
  registerClaimsCommands(program, { stateDir, instanceRoot, now: () => now });
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  try {
    const store = new ClaimsLedger({ stateDir, now: () => now });
    store.add({ id: 'C1', claim: '측정된 코드가 있습니다.', audience: 'personal', owner: 'MK' });
    store.verify('C1', { value: '420만+ 줄', command: 'measure-C1', measuredAt: now.toISOString(), validUntil: '2026-10-06T00:00:00Z', by: 'TC' });
    store.publish('C1', 'MK');
    program.parse(['claims', 'render', '--surface', 'deck'], { from: 'user' });
    expect(lines.join('\n')).toContain('측정된 코드가 있습니다.');
    expect(lines.join('\n')).not.toContain('src:patents');
    expect(existsSync(join(stateDir, 'patents', 'patents.sqlite'))).toBe(false);
    const patentCommand = (...args: string[]) => {
      const cli = new Command();
      registerClaimsCommands(cli, { stateDir, instanceRoot, now: () => now });
      cli.parse(['claims', 'patents', ...args], { from: 'user' });
    };
    patentCommand('add', 'PUBLIC-D', '--title', '공개 허용 후보 D.', '--track', '출원');
    patentCommand('add', 'PENDING', '--title', '출원 전 후보.', '--track', '출원');
    patentCommand('status', 'PUBLIC-D', '--status', '공개 허용');
    patentCommand('status', 'PENDING', '--status', '출원');
    lines.length = 0;
    const defaultWithPatents = new Command();
    registerClaimsCommands(defaultWithPatents, { stateDir, instanceRoot, now: () => now });
    const patentRead = spyOn(PatentLedger.prototype, 'listPublicCandidates').mockImplementation(() => { throw new Error('default render read patent ledger'); });
    try { defaultWithPatents.parse(['claims', 'render', '--surface', 'deck'], { from: 'user' }); }
    finally { patentRead.mockRestore(); }
    expect(lines.join('\n')).not.toContain('공개 허용 후보 D.');
    expect(lines.join('\n')).not.toContain('src:patents');
    lines.length = 0;
    const explicit = new Command();
    registerClaimsCommands(explicit, { stateDir, instanceRoot, now: () => now });
    explicit.parse(['claims', 'render', '--surface', 'deck', '--audience', 'team', '--patent-owner', 'MK', '--include-patents'], { from: 'user' });
    const rendered = lines.join('\n');
    expect(rendered).toContain('## 왜 엘라누스인가');
    expect(rendered).toContain('공개 허용 후보 D.');
    expect(rendered).toContain('<!-- claim:PUBLIC-D patent --> <!-- src:patents -->');
    expect(rendered).not.toContain('출원 전 후보.');
  } finally {
    spy.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(instanceRoot, { recursive: true, force: true });
  }
}, 120000);
