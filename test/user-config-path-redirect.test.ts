// Config path precedence (OP 2026-10-18): explicit config dir > selected state root >
// legacy XDG_CONFIG_HOME > default. XDG-only callers keep the legacy path.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userConfigPath } from '../src/user-config';
import { userConfigPath as nexusUserConfigPath } from '../src/nexus/config/paths';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';


const prevXdg = process.env.XDG_CONFIG_HOME;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cfg-redirect-'));
  delete process.env.XDG_CONFIG_HOME;
  resetElanousConfigDir();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  resetElanousConfigDir();
});

describe('userConfigPath · Phase 1 redirect', () => {
  test('no override → the effective instance root config (NEXUS canonical)', () => {
    // ⛔ «~/.elanous» 가 아니다 — config-dir 은 state-dir 을 따라간다(§4d · `elanous-config-dir.ts`). 운영에선 ~/.elanous,
    //   시험 프리로드(`test/preload-isolation.ts`)가 ELANOUS_STATE_DIR 을 격리하면 그 뿌리다.
    expect(userConfigPath()).toBe(join(effectiveInstanceRoot(), 'config.json'));
    expect(userConfigPath()).toBe(nexusUserConfigPath());
  });

  test('setElanousConfigDir override → <override>/config.json', () => {
    setElanousConfigDir(tmpRoot);
    expect(userConfigPath()).toBe(join(tmpRoot, 'config.json'));
    expect(userConfigPath()).toBe(nexusUserConfigPath());
  });

  test('XDG-only caller retains legacy path when no state root is selected', () => {
    process.env.XDG_CONFIG_HOME = tmpRoot;
    const selectedStateDir = process.env.ELANOUS_STATE_DIR;
    delete process.env.ELANOUS_STATE_DIR;
    try {
      expect(userConfigPath()).toBe(join(tmpRoot, 'elanous', 'config.json'));
    } finally {
      if (selectedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = selectedStateDir;
    }
  });

  test('explicit config dir wins over legacy XDG for Path A reads', () => {
    process.env.XDG_CONFIG_HOME = tmpRoot;
    setElanousConfigDir(join(tmpRoot, 'daemon-dir'));
    expect(userConfigPath()).toBe(join(tmpRoot, 'daemon-dir', 'config.json'));
  });

  test('empty XDG_CONFIG_HOME falls through to NEXUS helper', () => {
    process.env.XDG_CONFIG_HOME = '   ';
    expect(userConfigPath()).toBe(nexusUserConfigPath());
  });
});
