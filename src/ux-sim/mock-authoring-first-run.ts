/** N08 first-run probe: a fresh Bun process with isolated HOME and PATH. */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import type { DetectedProvider } from '../llm/provider-detect.js';

export interface MockAuthoringFirstRunSpec {
  runId: string;
  /** Omit to run real detection in the isolated HOME. */
  detected?: Array<{ provider: string; auth: DetectedProvider['auth'] }>;
  artifactPath?: string;
  timeoutMs?: number;
}

export interface MockAuthoringFirstRunEvidence {
  runId: string;
  outcome: 'ready' | 'needs-llm' | 'cancelled';
  provider: string | null;
  inputs: number;
  configReady: boolean;
  /** Credential resolver in the isolated child; fixture detection alone can still produce ready. */
  credentialSource: string;
  detectionMode: 'fixture' | 'real';
  detectedProviders: string[] | null;
  lines: string[];
  home: string;
  stateDir: string;
  stateDirSource: string;
  binarySha256: string;
  entrySha256: string;
  firstRunSha256: string;
  userConfigSha256: string;
  elapsedMs: number;
  exitCode: number;
}

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function mockAuthoringFirstRun(spec: MockAuthoringFirstRunSpec): MockAuthoringFirstRunEvidence {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(spec.runId)) throw new Error('N08 runId must be a safe token');
  if (spec.detected !== undefined && !Array.isArray(spec.detected)) throw new Error('N08 detected providers must be an array');
  const root = mkdtempSync(join(tmpdir(), `elanous-n08-${spec.runId}-`));
  const entry = join(import.meta.dir, 'mock-authoring-first-run-child.ts');
  const fixturePath = join(root, 'fixture.json');
  const stateDir = join(root, '.elanous-test');
  const configPath = join(stateDir, 'config.json');
  const binDir = join(root, 'bin');
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(binDir);
    symlinkSync(process.execPath, join(binDir, 'bun'));
    writeFileSync(fixturePath, JSON.stringify({ detected: spec.detected }));
    const started = performance.now();
    const childEnv: NodeJS.ProcessEnv = {
      PATH: binDir,
      NODE_ENV: process.env.NODE_ENV ?? 'test',
      LANG: process.env.LANG ?? 'C.UTF-8',
      // The first-run Korean hint is asserted by mock-authoring-first-run.test.ts;
      // pin the locale so the runner's LANG cannot flip detectLocale() to 'en'.
      ELANOUS_LANG: 'ko',
      HOME: root,
      XDG_DATA_HOME: join(root, '.local', 'share'), XDG_CACHE_HOME: join(root, '.cache'),
      ELANOUS_STATE_DIR: stateDir, ELANOUS_STATE_DIR_SOURCE: 'explicit',
    };
    const child = spawnSync(process.execPath, [entry, fixturePath, configPath, spec.runId], {
      cwd: root, encoding: 'utf8', timeout: spec.timeoutMs ?? 120_000, env: childEnv,
      maxBuffer: SPAWN_SYNC_MAX_BUFFER,
    });
    const elapsedMs = Math.round(performance.now() - started);
    const line = child.stdout?.split('\n').find(part => part.startsWith('N08_EVIDENCE='));
    if (child.error || child.status !== 0 || !line) {
      throw new Error(`N08 child failed: exit=${child.status} signal=${child.signal} stderr=${child.stderr?.slice(-500)}`);
    }
    const measured = JSON.parse(line.slice('N08_EVIDENCE='.length)) as Omit<MockAuthoringFirstRunEvidence,
      'binarySha256' | 'entrySha256' | 'firstRunSha256' | 'userConfigSha256' | 'elapsedMs' | 'exitCode'>;
    if (measured.home !== root || measured.stateDir !== stateDir
      || measured.stateDirSource !== 'explicit' || measured.runId !== spec.runId) {
      throw new Error('N08 isolated child identity mismatch');
    }
    const evidence: MockAuthoringFirstRunEvidence = {
      ...measured, binarySha256: sha256File(process.execPath), entrySha256: sha256File(entry),
      firstRunSha256: sha256File(join(import.meta.dir, '../onboarding/first-run.ts')),
      userConfigSha256: sha256File(join(import.meta.dir, '../user-config.ts')),
      elapsedMs, exitCode: child.status,
    };
    if (spec.artifactPath) {
      mkdirSync(dirname(spec.artifactPath), { recursive: true });
      writeFileSync(spec.artifactPath, JSON.stringify(evidence, null, 2) + '\n');
    }
    return evidence;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
