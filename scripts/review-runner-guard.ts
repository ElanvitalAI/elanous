#!/usr/bin/env bun
/**
 * A204 REVIEW-RUNNER-ROBUST — one entrance for OP/RES review runners.
 *
 *   bun scripts/review-runner-guard.ts preflight <pr> --head <sha> [--base-ref main] [--repo <git dir>]
 *   bun scripts/review-runner-guard.ts begin <pr> --seat <seat> --engine <engine> [--no-marker]
 *   bun scripts/review-runner-guard.ts heartbeat --token <token>
 *   bun scripts/review-runner-guard.ts end <pr> --token <token> [--outcome <text>]
 *   bun scripts/review-runner-guard.ts status <pr>
 *   bun scripts/review-runner-guard.ts clear <pr> --head <sha>   (remove a terminal record; records also expire)
 *   bun scripts/review-runner-guard.ts reclaim
 *
 * Common: --ledger-root <dir> (default HQ OP/review-acp-slots) · --cap-file <file> (default
 * K-EAST heavy-slot-review-cap.txt, read only). Output is one JSON line. Exit codes:
 * 0 ok · 3 needs-clean-branch/terminal · 4 cap-full · 5 already-reviewing · 6 ledger busy/unavailable ·
 * 7 identity changed during review · 2 usage.
 * It never starts a reviewer: the caller admits Terra/Claude only after `preflight` 0 and `begin` 0.
 */
import { spawnSync } from 'node:child_process';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import {
  compareFrozenIdentity, postFreezeMarker, preflightMergeHistory, readPrIdentity, releaseFreezeMarker,
  ReviewSlotLedger, type FrozenIdentity, type GhRunner, type GitRunner, type LedgerDeps,
} from '../src/agent-substrate/review-runner-guard.js';

export interface GuardCliDeps {
  gh: GhRunner;
  git: GitRunner;
  now(): number;
  host: string;
  pid: number;
  pidAlive(pid: number): boolean;
  print(line: string): void;
  home: string;
  token?(): string;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function runReviewRunnerGuardCli(argv: string[], deps: GuardCliDeps): number {
  const [command, ...rest] = argv;
  const valueFlags = new Set(['--head', '--base-ref', '--repo', '--seat', '--engine', '--token', '--outcome', '--ledger-root', '--cap-file']);
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (valueFlags.has(rest[index]!)) { index += 1; continue; }
    if (!rest[index]!.startsWith('--')) positional.push(rest[index]!);
  }
  const pr = positional[0]?.replace(/^#/, '');
  const ledgerDeps: LedgerDeps = {
    root: flag(rest, '--ledger-root') ?? process.env.ELANOUS_REVIEW_SLOT_ROOT ?? join(deps.home, 'elanous-hq/seat-state/OP/review-acp-slots'),
    capFile: flag(rest, '--cap-file') ?? process.env.ELANOUS_REVIEW_CAP_FILE ?? join(deps.home, 'elanous-hq/seat-state/K-EAST/tools/heavy-slot-review-cap.txt'),
    now: deps.now, host: deps.host, pid: deps.pid, pidAlive: deps.pidAlive,
    ...(deps.token ? { token: deps.token } : {}),
  };
  const ledger = new ReviewSlotLedger(ledgerDeps);
  const out = (value: unknown, code: number): number => { deps.print(JSON.stringify(value)); return code; };
  const iso = () => new Date(deps.now()).toISOString();
  const needPr = () => pr && /^\d+$/.test(pr);

  switch (command) {
    case 'preflight': {
      const head = (flag(rest, '--head') ?? '').toLowerCase();
      const baseRef = flag(rest, '--base-ref') ?? 'main';
      if (!needPr() || !/^[0-9a-f]{40}$/.test(head) || !/^[\w./-]{1,255}$/.test(baseRef)) return out({ error: 'usage: preflight <pr> --head <sha40> [--base-ref main]' }, 2);
      const repo = flag(rest, '--repo');
      const git: GitRunner = (args) => deps.git(repo ? ['-C', repo, ...args] : args);
      const terminal = ledger.terminalRefusal(pr!, head);
      if (terminal) return out({ ...terminal, source: 'ledger-terminal' }, 3);
      if (git(['cat-file', '-e', `${head}^{commit}`]).status !== 0 && git(['fetch', '--no-tags', 'origin', head]).status !== 0) {
        return out({ pr, head, status: 'unmeasured', reason: 'head-fetch-failed' }, 0);
      }
      if (git(['fetch', '--no-tags', 'origin', `refs/heads/${baseRef}`]).status !== 0) return out({ pr, head, status: 'unmeasured', reason: 'base-fetch-failed' }, 0);
      const baseTip = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).stdout.trim();
      const result = preflightMergeHistory({ pr: pr!, head, baseTip, git });
      if ('refusal' in result) {
        const path = ledger.recordTerminalRefusal(result);
        return out({ ...result, terminalRecord: path, observedAt: iso() }, 3);
      }
      return out({ pr, head, ...result }, 0);
    }
    case 'begin': {
      const seat = flag(rest, '--seat');
      const engine = flag(rest, '--engine');
      if (!needPr() || !seat || !engine) return out({ error: 'usage: begin <pr> --seat <seat> --engine <engine>' }, 2);
      const identity = readPrIdentity(pr!, deps.gh);
      if ('error' in identity) return out({ pr, status: 'unavailable', reason: identity.error }, 6);
      const frozen: FrozenIdentity = { pr: pr!, ...identity, frozenAt: iso() };
      const acquired = ledger.acquire({ pr: pr!, head: identity.head, seat, engine, frozen });
      if (acquired.status !== 'acquired') {
        const code = acquired.status === 'terminal-refusal' ? 3 : acquired.status === 'cap-full' ? 4
          : acquired.status === 'already-reviewing' ? 5 : 6;
        return out({ pr, head: identity.head, ...acquired }, code);
      }
      const markerCommentId = rest.includes('--no-marker') ? undefined : postFreezeMarker(pr!, identity, deps.gh);
      if (markerCommentId) {
        // Keep the marker id beside the frozen identity so `end` can update the same comment.
        ledger.attachMarker(acquired.token, markerCommentId);
      }
      return out({ pr, status: 'acquired', slot: acquired.slot, token: acquired.token, frozen, markerCommentId: markerCommentId ?? null, reclaimed: acquired.reclaimed }, 0);
    }
    case 'heartbeat': {
      const token = flag(rest, '--token');
      if (!token) return out({ error: 'usage: heartbeat --token <token>' }, 2);
      return ledger.heartbeat(token) ? out({ status: 'heartbeat', at: iso() }, 0) : out({ status: 'not-owner' }, 6);
    }
    case 'end': {
      const token = flag(rest, '--token');
      if (!needPr() || !token) return out({ error: 'usage: end <pr> --token <token>' }, 2);
      const owned = ledger.owner(token);
      if (!owned || owned.pr !== pr || !owned.frozen) return out({ pr, status: 'not-owner' }, 6);
      const current = readPrIdentity(pr!, deps.gh);
      const check = 'error' in current
        ? { match: false as const, refusal: 'identity-unmeasured', reason: current.error }
        : compareFrozenIdentity(owned.frozen, current, iso());
      const outcome = flag(rest, '--outcome') ?? (check.match ? 'identity-held' : String((check as { refusal: string }).refusal));
      const markerReleased = releaseFreezeMarker(owned.frozen.markerCommentId, outcome, deps.gh);
      ledger.release(token, { outcome, identity: check });
      return out({ pr, status: 'released', identity: check, markerReleased }, check.match ? 0 : 7);
    }
    case 'status': {
      if (!needPr()) return out({ error: 'usage: status <pr>' }, 2);
      return out({ pr, ...ledger.status(pr!) }, 0);
    }
    case 'clear': {
      const head = (flag(rest, '--head') ?? '').toLowerCase();
      if (!needPr() || !/^[0-9a-f]{40}$/.test(head)) return out({ error: 'usage: clear <pr> --head <sha40>' }, 2);
      return out({ pr, head, cleared: ledger.clearTerminalRefusal(pr!, head) }, 0);
    }
    case 'reclaim': {
      const result = ledger.reclaimStale();
      return out(result, 'status' in result ? 6 : 0);
    }
    default:
      return out({ error: 'usage: preflight|begin|heartbeat|end|status|clear|reclaim' }, 2);
  }
}

if (import.meta.main) {
  const run = (bin: string) => (args: string[]) => {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  process.exitCode = runReviewRunnerGuardCli(process.argv.slice(2), {
    gh: run('gh'), git: run('git'), now: () => Date.now(), host: hostname(), pid: process.pid,
    pidAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    print: (line) => process.stdout.write(`${line}\n`), home: homedir(),
  });
}
