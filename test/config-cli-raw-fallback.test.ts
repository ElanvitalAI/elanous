// FU1 (PLAN-config-unification-elanous-root-2026-05-10 closing follow-up):
//   `elanous config get <dotted-path>` resolves through cfg.raw when the
//   path leaves the typed UserConfig schema (e.g. voice.stt.language ·
//   user-defined keys preserved by buildUserConfig's catch-all).
//
// This test invokes the CLI as a subprocess so we exercise the same
// helpers (`getConfigPath` + `buildUserConfig` + `userConfigPath`) that
// production code uses. `--config-dir <dir>` isolates the config file so
// the user's real ~/.elanous/config.json is untouched. (Legacy
// ELANOUS_DAEMON_DIR env was removed in PR #2534.)

import { setDefaultTimeout, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

let daemonDir: string;
let cfgPath: string;
const REPO_ROOT = join(import.meta.dir, '..');
const ENTRY = join(REPO_ROOT, 'src/index.ts');

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[\d?;<>=]*[a-zA-Z]/g, '');
}
function firstNonEmptyLine(s: string): string {
  for (const line of stripAnsi(s).split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
function runConfigGet(path: string): { stdout: string; stderr: string; code: number; first: string } {
  const r = spawnSync('bun', [ENTRY, '--config-dir', daemonDir, 'config', 'get', path], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELANOUS_SUPPRESS_XDG_WARNING: '1',
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  const stdout = r.stdout ?? '';
  return {
    stdout,
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
    first: firstNonEmptyLine(stdout),
  };
}

beforeEach(() => {
  daemonDir = mkdtempSync(join(tmpdir(), 'fu1-raw-fallback-'));
  cfgPath = join(daemonDir, 'config.json');
  // Seed a unified file with both typed and untyped paths.
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({
    version: 1,
    global: { nexus: { pwa: { shareTailnet: 'enabled' } } },
    tabs: {},
    llm: { provider: 'anthropic' },
    voice: {
      stt: { language: 'ko' },          // not in typed VoiceSttConfig — raw fallback target
      tts: {},
      vad: {},
      chat: {},
      discord: {},
      telegram: {},
      pwa: {},
    },
    custom: { user: { defined: 'arbitrary' } }, // unknown root key in cfg.raw
  }));
});

afterEach(() => {
  rmSync(daemonDir, { recursive: true, force: true });
});

describe('FU1 · elanous config get · raw fallback', () => {
  test('typed Path A key resolves directly', () => {
    const r = runConfigGet('llm.provider');
    expect(r.code).toBe(0);
    expect(r.first).toBe('anthropic');
  });

  test('NEXUS schema key resolves via typed root', () => {
    const r = runConfigGet('global.nexus.pwa.shareTailnet');
    expect(r.code).toBe(0);
    expect(r.first).toBe('enabled');
  });

  test('user-defined nested key inside typed sub-schema resolves via raw fallback', () => {
    // voice.stt.language is NOT in typed VoiceSttConfig but IS in cfg.raw.
    const r = runConfigGet('voice.stt.language');
    expect(r.code).toBe(0);
    expect(r.first).toBe('ko');
  });

  test('unknown root key resolves via raw fallback', () => {
    const r = runConfigGet('custom.user.defined');
    expect(r.code).toBe(0);
    expect(r.first).toBe('arbitrary');
  });

  test('genuinely missing path still errors', () => {
    const r = runConfigGet('llm.does-not-exist');
    expect(r.code).not.toBe(0);
    const combined = stripAnsi(r.stdout + r.stderr).toLowerCase();
    expect(combined).toContain('not found');
  });
});
