import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig } from '../user-config.js';

let root: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bash-approval-config-'));
  configPath = join(root, 'config.json');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('shell.bashApproval config', () => {
  test('defaults to dangerous commands only', () => {
    writeFileSync(configPath, JSON.stringify({ shell: { allowDashboardBash: true } }));
    expect(buildUserConfig(configPath).shell.bashApproval).toBe('dangerous');
  });

  test('allows opting into confirmation for every Bash call', () => {
    writeFileSync(configPath, JSON.stringify({ shell: { allowDashboardBash: true, bashApproval: 'all' } }));
    expect(buildUserConfig(configPath).shell.bashApproval).toBe('all');
  });

  test('normalizes unsupported policy values to the safe default', () => {
    writeFileSync(configPath, JSON.stringify({ shell: { bashApproval: 'none' } }));
    expect(buildUserConfig(configPath).shell.bashApproval).toBe('dangerous');
  });
});
