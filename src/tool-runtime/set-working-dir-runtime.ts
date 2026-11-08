import type { LLMToolSpec } from '../llm/tool-spec.js';
// SetWorkingDir ToolRuntime — Phase WD8.
//
// LLM-invoked switch of the session working directory (SWD). Every
// later Read / Edit / Write / Shell / Grep / Glob that defaults its
// cwd will resolve against the new SWD (WD4–WD7). The Ctrl+W browser
// binding and the /wd slash command write to the same singleton.
//
// Guardrails:
//   • Path is resolved + statSync-checked in setSessionCwd itself.
//   • An allowlist check keeps the LLM from jumping outside HOME.
//     The env var ELANOUS_SWD_ALLOW_OUTSIDE_HOME=1 turns the check off
//     for power users (CI, multi-root devs) — documented in LESSONS.

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  getSessionCwd,
  setSessionCwd,
  type SessionWorkingDir,
} from '../session/working-dir.js';
import type { ToolRuntime } from './types.js';

// Read the user's HOME. Prefer the env var so tests can override; fall
// back to os.homedir() for environments (e.g. some CI shells) that
// don't export HOME explicitly.
function userHome(): string {
  return process.env.HOME || homedir() || '';
}

function isInsideHome(abs: string): boolean {
  const home = userHome();
  if (!home) return true; // no HOME → skip guard
  const normHome = home.endsWith('/') ? home : home + '/';
  return abs === home || abs.startsWith(normHome);
}

function expandHome(raw: string): string {
  const home = userHome();
  if (!home) return raw;
  if (raw === '~' || raw === '~/') return home;
  if (raw.startsWith('~/')) return home + raw.slice(1);
  return raw;
}

function buildSpec(): LLMToolSpec {
  return {
    name: 'SetWorkingDir',
    description:
      'Promote a directory to the session working directory (SWD). Affects the default cwd ' +
      'of every subsequent Read / Edit / Write / Shell / Grep / Glob call and of newly-spawned ' +
      'shells. Path is resolved absolute; relative paths resolve against the current SWD. ' +
      'Target must exist and be a directory. By default, targets outside the user\'s HOME are ' +
      'rejected (set ELANOUS_SWD_ALLOW_OUTSIDE_HOME=1 to override).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Target directory. Absolute, ~-prefixed, or relative (resolved against the current SWD).',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  };
}

export interface SetWorkingDirResult {
  output: string;
  cwd: string;
  origin: SessionWorkingDir['origin'];
}

export const setWorkingDirRuntime: ToolRuntime<Record<string, unknown>, SetWorkingDirResult> = {
  id: 'set_working_dir',
  spec: buildSpec(),
  async run(req): Promise<SetWorkingDirResult> {
    const raw = typeof req.path === 'string' ? req.path.trim() : '';
    if (!raw) throw new Error('SetWorkingDir: `path` is required');
    const expanded = expandHome(raw);
    const abs = resolve(getSessionCwd(), expanded);
    if (!isInsideHome(abs) && process.env.ELANOUS_SWD_ALLOW_OUTSIDE_HOME !== '1') {
      throw new Error(
        `SetWorkingDir: path ${abs} is outside HOME; set ELANOUS_SWD_ALLOW_OUTSIDE_HOME=1 to override.`,
      );
    }
    const next = setSessionCwd(abs, 'tool');
    return {
      output: `✓ working dir → ${next.cwd}`,
      cwd: next.cwd,
      origin: next.origin,
    };
  },
};
