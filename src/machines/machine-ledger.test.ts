import { setDefaultTimeout, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadMachineLedger, machineLedgerPath, machineMarkdownPath, renderLedgerMarkdown, setMachineField, validateMachineLedger } from './machine-ledger.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const fixture = () => ({ title: 'Machine ledger', policy: ['YAML only'], machines: [{ id: 'mbp', name: 'mbp', specs: 'M5', locationStatus: 'office', role: 'work', duties: 'build' }], devices: [{ id: 'phone', name: 'Phone', status: 'active', purpose: 'demo' }], rules: ['no secrets'], changes: ['initial'] });

test('ledger rejects malformed fields, ids and secret-like values on load and edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-ledger-'));
  mkdirSync(join(root, 'docs/ops'), { recursive: true });
  try {
    for (const value of [
      { ...fixture(), extra: true },
      { ...fixture(), machines: [{ ...fixture().machines[0], id: '' }] },
      { ...fixture(), devices: [{ ...fixture().devices[0], id: 'mbp' }] },
      { ...fixture(), machines: [{ ...fixture().machines[0], duties: 'ghp_1234567890123456' }] },
      { ...fixture(), machines: [{ ...fixture().machines[0], duties: 'fe80::1' }] },
    ]) {
      writeFileSync(machineLedgerPath(root), stringify(value));
      expect(() => loadMachineLedger(root)).toThrow();
    }
    writeFileSync(machineLedgerPath(root), stringify(fixture()));
    expect(() => setMachineField(root, 'mbp', 'unknown', 'x')).toThrow();
    expect(() => setMachineField(root, 'mbp', 'role', 'ghp_1234567890123456')).toThrow();
    expect(loadMachineLedger(root).machines[0]?.role).toBe('work');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tailnet IP edit is rejected without changing YAML or Markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-ledger-'));
  mkdirSync(join(root, 'docs/ops'), { recursive: true });
  try {
    writeFileSync(machineLedgerPath(root), stringify(fixture()));
    writeFileSync(machineMarkdownPath(root), renderLedgerMarkdown(loadMachineLedger(root)));
    const yamlBefore = readFileSync(machineLedgerPath(root), 'utf8');
    const markdownBefore = readFileSync(machineMarkdownPath(root), 'utf8');
    for (const address of ['100.64.1.2', 'fe80::1', '2001:db8::1', '::1']) {
      const result = spawnSync(process.execPath, [join(import.meta.dir, '../../bin/elanous.mjs'), `--test=${root}`, 'machine', 'ledger-set', 'mbp', 'duties', `connect to ${address}`], { cwd: root, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('secret-like');
      expect(readFileSync(machineLedgerPath(root), 'utf8')).toBe(yamlBefore);
      expect(readFileSync(machineMarkdownPath(root), 'utf8')).toBe(markdownBefore);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('accounts, tokens, pipes and line breaks are rejected without changing YAML or Markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-ledger-'));
  mkdirSync(join(root, 'docs/ops'), { recursive: true });
  try {
    writeFileSync(machineLedgerPath(root), stringify(fixture()));
    writeFileSync(machineMarkdownPath(root), renderLedgerMarkdown(loadMachineLedger(root)));
    const yamlBefore = readFileSync(machineLedgerPath(root), 'utf8');
    const markdownBefore = readFileSync(machineMarkdownPath(root), 'utf8');
    for (const value of ['ask owner@example.com', 'bot xoxb-1234567890-abcdef', 'tskey-auth-abcdefgh1234', 'token=abc123', 'a | b', 'line one\nline two']) {
      expect(() => setMachineField(root, 'mbp', 'duties', value)).toThrow();
      expect(readFileSync(machineLedgerPath(root), 'utf8')).toBe(yamlBefore);
      expect(readFileSync(machineMarkdownPath(root), 'utf8')).toBe(markdownBefore);
    }
    // A pod pool spec carries «@» without being an account.
    expect(() => setMachineField(root, 'mbp', 'duties', 'pods on `pool-node-b@node-b:8`')).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable-device heading follows YAML policy and render --check detects changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-ledger-'));
  mkdirSync(join(root, 'docs/ops'), { recursive: true });
  try {
    const original = fixture();
    original.policy.push('창은 들고 다니는 기기 · 전부 tailnet 으로 본부·작업실에 붙는다.');
    writeFileSync(machineLedgerPath(root), stringify(original));
    const before = renderLedgerMarkdown(loadMachineLedger(root));
    writeFileSync(machineMarkdownPath(root), before);
    const changed = { ...original, policy: original.policy.map((line) => line.startsWith('창은 ') ? '창은 수정한 정책 · 원격으로 붙는다.' : line) };
    writeFileSync(machineLedgerPath(root), stringify(changed));
    const after = renderLedgerMarkdown(loadMachineLedger(root));
    expect(after).not.toBe(before);
    expect(after).toContain('## 2. 창 (수정한 정책 · 원격으로 붙는다)');
    const result = spawnSync(process.execPath, [join(import.meta.dir, '../../bin/elanous.mjs'), `--test=${root}`, 'machine', 'render', '--check'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('machine ledger Markdown stale');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderer rejects a secret-like mutation rather than publishing it', () => {
  const ledger = fixture();
  ledger.machines[0]!.duties = 'ghp_1234567890123456';
  expect(() => renderLedgerMarkdown(ledger)).toThrow('secret-like');
});

test('ledger set edits YAML and regenerates Markdown from that single source', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-ledger-'));
  mkdirSync(join(root, 'docs/ops'), { recursive: true });
  try {
    writeFileSync(machineLedgerPath(root), `# YAML is the source\n${stringify(fixture())}`);
    setMachineField(root, 'mbp', 'role', 'control');
    setMachineField(root, 'phone', 'purpose', 'approval');
    setMachineField(root, 'mbp', 'duties', 'build and test');
    const yaml = readFileSync(machineLedgerPath(root), 'utf8');
    expect(yaml).toStartWith('# YAML is the source\n');
    expect(yaml.match(/# YAML is the source/g)).toHaveLength(1);
    expect(loadMachineLedger(root).machines[0]?.role).toBe('control');
    expect(loadMachineLedger(root).devices[0]?.purpose).toBe('approval');
    expect(readFileSync(machineMarkdownPath(root), 'utf8')).toBe(renderLedgerMarkdown(loadMachineLedger(root)));
    expect(readFileSync(machineMarkdownPath(root), 'utf8')).toContain('| `mbp` | M5 | office | control | build and test |');
    expect(() => validateMachineLedger({ ...fixture(), devices: [{ ...fixture().devices[0], status: '10.1.2.3' }] })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
