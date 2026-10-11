// 자식 elanous 기동의 단일 입구. 우주는 부모가 한 번 정해 ELANOUS_STATE_DIR 도장으로 물려준다.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { stateDirSourceForChild } from '../agent/identity-env.js';
import { effectiveInstanceRoot } from './resolve.js';

const DEFAULT_BIN = resolve(import.meta.dir, '../../bin/elanous.mjs');

export interface SpawnElanousOptions {
  /** 자식이 쓸 우주. 생략하면 부모의 effectiveInstanceRoot(). 명시한 값이 이긴다. */
  stateDir?: string;
  /** 실행할 elanous 진입 스크립트. 생략하면 이 트리의 bin/elanous.mjs. */
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ElanousInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** 자식 기동 명세를 만든다. env 는 부모 env 위에 우주 도장(뿌리 ⊕ 출처)을 얹은 것이다. */
export function elanousInvocation(args: readonly string[], opts: SpawnElanousOptions = {}): ElanousInvocation {
  const root = opts.stateDir?.trim() || effectiveInstanceRoot();
  const base = opts.env ?? process.env;
  return {
    command: process.execPath,
    args: [opts.bin ?? DEFAULT_BIN, ...args],
    env: { ...base, ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(root, base) },
  };
}

export function spawnElanous(args: readonly string[], opts: SpawnElanousOptions & Omit<SpawnOptions, 'env' | 'cwd'> = {}): ChildProcess {
  const { stateDir: _s, bin: _b, env: _e, ...rest } = opts;
  const inv = elanousInvocation(args, opts);
  return spawn(inv.command, inv.args, { ...rest, cwd: opts.cwd, env: inv.env });
}

export function spawnElanousSync(args: readonly string[], opts: SpawnElanousOptions & Omit<SpawnSyncOptions, 'env' | 'cwd'> = {}): SpawnSyncReturns<string | Buffer> {
  const { stateDir: _s, bin: _b, env: _e, ...rest } = opts;
  const inv = elanousInvocation(args, opts);
  return spawnSync(inv.command, inv.args, { ...rest, cwd: opts.cwd, env: inv.env });
}
