import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { checkClaudeSubscription } from '../agent-mission/claude-subscription.js';
import { resolveBackend, runAgentMission } from '../agent-mission/driver.js';
import { debug } from '../debug/log.js';
import { emitDecision } from '../live/detail-switch.js';
import type { BrollAgent } from './recipes/broll.js';

export interface BrollAgentOptions {
  backend: 'codex' | 'claude' | 'elanous';
  clipsDir: string;
  skillDir: string;
  runMission?: typeof runAgentMission;
  runElanous?: (prompt: string, cwd: string, signal: AbortSignal) => Promise<void>;
  claudeAvailable?: () => Promise<boolean>;
}

async function defaultRunElanous(prompt: string, cwd: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // `agent` currently requires positional text; relay stdin without interpolating prompt into shell code.
    const child = spawn('sh', ['-c', 'prompt=$(cat); exec elanous agent --new --json "$prompt"'],
      { cwd, signal, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`elanous agent exit ${code}`)));
    child.stdin.end(prompt);
  });
}

function safeClip(path: string, dir: string, name: string): boolean {
  try {
    const root = realpathSync(dir);
    const clip = realpathSync(path);
    const rel = relative(root, clip);
    const stat = lstatSync(path);
    return rel === name && stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

/** Each invocation authors exactly one clip in the mission workdir. */
export function createBrollAgent(opts: BrollAgentOptions): BrollAgent {
  const clipsDir = resolve(opts.clipsDir);
  const runMission = opts.runMission ?? runAgentMission;
  const runElanous = opts.runElanous ?? defaultRunElanous;
  const claudeAvailable = opts.claudeAvailable ?? (async () => checkClaudeSubscription({ env: process.env }).ok);
  return async (slot, { signal }) => {
    const milliseconds = Math.round(slot.start * 1000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      debug.log('video.broll-agent', 'skipped', { backend: opts.backend, slot: 'invalid', reason: 'invalid-slot-start' });
      return null;
    }
    const name = `slot-${String(milliseconds).padStart(6, '0')}.mp4`;
    const output = join(clipsDir, name);
    const prompt = `Read and follow the motion B-roll skill at ${join(opts.skillDir, 'SKILL.md')} (including its engine reference).\n` +
      `Author one motion-graphic clip for this slot. Spoken words: ${slot.prompt}\n` +
      `Start: ${slot.start} seconds; end: ${slot.end} seconds; clip duration: ${slot.end - slot.start} seconds.\n` +
      `Produce exactly one output clip at ${output}. Do not write outside the workdir ${clipsDir}. ` +
      `Keep any intermediate files inside the workdir. Do not ask for approval; complete this assigned clip.\n` +
      `The final evidence must be the new file ${name}.`;
    let backend: BrollAgentOptions['backend'] = opts.backend;
    debug.log('video.broll-agent', 'start', { backend, slot: name, reason: 'slot' });
    try {
      try {
        lstatSync(output);
        if (!safeClip(output, clipsDir, name)) {
          debug.log('video.broll-agent', 'skipped', { backend, slot: name, reason: 'existing-unsafe-clip' });
          return null;
        }
        unlinkSync(output);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (backend === 'claude' && !await claudeAvailable()) {
        backend = 'codex';
        emitDecision({ kind: 'ROUTE', what: 'B-roll 저작 에이전트', reason: 'claude 로그인 없음 → codex', purpose: '클립 저작 계속', target: 'codex' });
        debug.log('video.broll-agent', 'route', { backend, slot: name, reason: 'claude 로그인 없음 → codex' });
      }
      if (backend === 'elanous') {
        await runElanous(prompt, clipsDir, signal);
        if (safeClip(output, clipsDir, name)) {
          debug.log('video.broll-agent', 'done', { backend, slot: name, reason: 'clip-created' });
          return output;
        }
        debug.log('video.broll-agent', 'skipped', { backend, slot: name, reason: 'clip-missing' });
        return null;
      }
      const result = await runMission({ mission: prompt, agent: resolveBackend(backend), workdir: clipsDir,
        evidence: { kind: 'doc', dirRel: '.', glob: new RegExp(`^${name.replace('.', '\\.')}$`) }, signal,
        headless: false, memory: false });
      if (result.ok && result.evidencePath && resolve(result.evidencePath) === output && safeClip(result.evidencePath, clipsDir, name)) {
        debug.log('video.broll-agent', 'done', { backend, slot: name, reason: 'evidence-verified' });
        return result.evidencePath;
      }
      debug.log('video.broll-agent', 'skipped', { backend, slot: name, reason: result.ok ? 'evidence-mismatch' : (result.reason ?? 'mission-failed') });
      return null;
    } catch (e) {
      debug.log('video.broll-agent', 'skipped', { backend, slot: name, reason: e instanceof Error ? e.name : 'agent-error' });
      return null;
    }
  };
}
