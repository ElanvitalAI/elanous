// ELS-CHANNEL P1b (내부 문서 `ELS-CHANNEL` §5-5 · 대표 11-27 01:0x) — how a loop agent's voice is found. A message on
// `loop:<id>` (or addressed to `loop:<id>`) becomes ONE call of that agent's voice adapter; the adapter contract is the whole
// interface: {from, channel, text, refs} → {text, evidence[], actions[]}. Two ways to register, nothing resident:
//   · in-process: registerLoopVoice(id, adapter) — a component living in the els server process;
//   · a command: <els>/loops/<id>.json {"voice":{"command":[…]}} — spawned once per message, the input as one
//     JSON line on stdin, the reply as the last JSON line on stdout (any process: a graph runner, the judge-butler, a script).
// The declaration file lives in the owner's els state folder (0700 · same-uid trust, CEO 11-24); it is read per message.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopVoiceAdapter, LoopVoiceReply } from './channel-log.js';

const LOOP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STDOUT_MAX = 64 * 1024;

const registered = new Map<string, LoopVoiceAdapter>();

/** In-process registration; returns the unregister function. */
export function registerLoopVoice(loop: string, adapter: LoopVoiceAdapter): () => void {
  if (!LOOP_ID_RE.test(loop)) throw new Error(`bad loop id ${JSON.stringify(loop)}`);
  registered.set(loop, adapter);
  return () => { if (registered.get(loop) === adapter) registered.delete(loop); };
}

export interface LoopVoiceDecl { readonly voice?: { readonly command?: readonly string[] } }

export const loopDeclPath = (loopsDir: string, loop: string): string => join(loopsDir, `${loop}.json`);

/** `els channel voice <loop> -- <command…>`: write the declaration (atomic · 0600). */
export function writeLoopVoiceDecl(loopsDir: string, loop: string, command: readonly string[]): void {
  if (!LOOP_ID_RE.test(loop)) throw new Error(`bad loop id ${JSON.stringify(loop)} (letters, digits, . _ -)`);
  if (!command.length || command.some((a) => typeof a !== 'string' || !a)) throw new Error('the voice command is empty');
  mkdirSync(loopsDir, { recursive: true, mode: 0o700 });
  const path = loopDeclPath(loopsDir, loop), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ voice: { command } } satisfies LoopVoiceDecl)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Parse the adapter's stdout: the last non-empty line that is a JSON object with a string `text`. */
export function parseVoiceReply(stdout: string): LoopVoiceReply | undefined {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (v && typeof v === 'object' && typeof v.text === 'string') {
        const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : []);
        return { text: v.text, evidence: strs(v.evidence), actions: strs(v.actions) };
      }
    } catch { /* not this line */ }
  }
  return undefined;
}

/** A command adapter: spawn once, JSON in, JSON out. The abort signal (the hub's deadline) ends exactly this child. */
export function commandVoice(command: readonly string[], env: NodeJS.ProcessEnv = process.env): LoopVoiceAdapter {
  return (input, signal) => new Promise<LoopVoiceReply>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ELANOUS_LOOP_ID: input.loop } });
    // Terra #40331 must-5: stdout is scanned line by line — only the last reply line and one partial line are kept (bounded),
    // so a chatty voice that logs megabytes before its answer still answers.
    let partial = '', reply: LoopVoiceReply | undefined, err = '';
    const take = (line: string): void => { const r = parseVoiceReply(line); if (r) reply = r; };
    const stop = (): void => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    signal.addEventListener('abort', stop, { once: true });
    let overlong = false; // inside a line longer than the bound: skip to its newline (it is not a reply)
    child.stdout.on('data', (c: Buffer) => {
      const lines = (partial + String(c)).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) { if (overlong) { overlong = false; continue; } take(line); }
      if (partial.length > STDOUT_MAX) { partial = ''; overlong = true; }
    });
    child.stderr.on('data', (c: Buffer) => { err = (err + String(c)).slice(-400); });
    child.on('error', (e) => { signal.removeEventListener('abort', stop); reject(e); });
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      if (code !== 0) { reject(new Error(`voice exited ${code}${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`)); return; }
      if (partial && !overlong) take(partial);
      if (reply) resolve(reply); else reject(new Error('voice printed no JSON reply line {"text":…}'));
    });
    child.stdin.on('error', () => { /* the child may exit before reading */ });
    child.stdin.end(`${JSON.stringify({ loop: input.loop, from: input.from, channel: input.channel, text: input.text, refs: input.refs, messageId: input.messageId })}\n`);
  });
}

/** The hub's `loopVoice` option: in-process first, then the declaration file; undefined = no voice. */
export function loopVoiceResolver(loopsDir: string): (loop: string) => LoopVoiceAdapter | undefined {
  return (loop) => {
    const inProcess = registered.get(loop);
    if (inProcess) return inProcess;
    const path = loopDeclPath(loopsDir, loop);
    if (!LOOP_ID_RE.test(loop) || !existsSync(path)) return undefined;
    try {
      const decl = JSON.parse(readFileSync(path, 'utf8')) as LoopVoiceDecl;
      const command = decl.voice?.command;
      return Array.isArray(command) && command.length && command.every((a) => typeof a === 'string' && a) ? commandVoice(command) : undefined;
    } catch { return undefined; }
  };
}
