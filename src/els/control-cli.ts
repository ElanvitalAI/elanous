// The local `els do` walks the one control door before it reaches the owner.
// The CLI is the transport, so it builds the Principal from the OS: the state folder must belong to the calling uid
// (otherwise refuse), and the principal is `local:<uid>`. `--from` is only the sender shown to the receiver.
// A remote `host:ws/tab/pane` is a different owner's door: this host does not authorize it.
// HITL is a question on stderr answered from stdin. No terminal, or no answer in time, is a timeout:
// the line is not sent.

import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseAddress } from './address.js';
import { createControl, type ControlOutcome, type ControlTarget, type HitlRequest, type IdResolver, type Principal } from './control.js';
import type { ElsResult } from './core.js';
import { findPane } from './journal.js';
import type { SpaceJournal } from './space.js';

export interface ControlledDoDeps {
  /** `<state>/els` — control-allow.json and control-audit.jsonl. */
  readonly stateDir: string;
  /** Shown to the receiver. Never the principal. */
  readonly from: string;
  /** The calling OS user. */
  readonly uid: number;
  /** Owner uid of the state folder; undefined when it does not exist yet. */
  readonly ownerUid?: (dir: string) => number | undefined;
  /** Resolve a pane ref to its workspace id, pane id, and whether it is a shell. Unknown = undefined. */
  readonly lookup: (pane: string) => Promise<ControlTarget | undefined>;
  /** Resolves names in the allow list to ids. */
  readonly resolve?: IdResolver;
  /** The owner's `do`, called only after the door says yes. */
  readonly send: (pane: string, text: string, from: string) => Promise<ElsResult>;
  readonly ask?: (question: string) => Promise<'approve' | 'deny' | 'timeout'>;
  readonly now?: () => number;
}

const queuedCount = (message: string): number | undefined => {
  const found = /queued (\d+)/.exec(message);
  return found ? Number(found[1]) : undefined;
};

function statOwner(dir: string): number | undefined {
  try { return statSync(dir).uid; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The CLI principal: `local:<uid>` when the state folder is ours (or not made yet); otherwise nobody. */
export function cliPrincipal(stateDir: string, uid: number, ownerUid: (dir: string) => number | undefined = statOwner): Principal | { readonly refused: string } {
  let owner: number | undefined;
  try { owner = ownerUid(stateDir); }
  catch (error) { return { refused: `state folder unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
  if (owner !== undefined && owner !== uid) return { refused: `state folder ${stateDir} belongs to uid ${owner}, not uid ${uid}` };
  // ELS-OP-ALLOW-RULE: merge ambient seat identity (no flags) — the door's coded defaults key on it.
  const ambient = ambientSeat();
  return { id: `local:${uid}`, kind: 'cli', ...ambient };
}

/** ELS-OP-ALLOW-RULE: seat identity from the environment — hands carry their seat name and the workspaces bound to them; OP carries 'OP'. */
function ambientSeat(): { seat?: string; workspaces?: readonly string[] } {
  const seat = process.env.ELANOUS_SEAT ?? process.env.SEAT;
  const workspaces = process.env.ELANOUS_WORKSPACES;
  return {
    ...(seat ? { seat } : {}),
    ...(workspaces ? { workspaces: workspaces.split(',').map((w) => w.trim()).filter(Boolean) } : {}),
  };
}

/** What the person is approving: who, as whom, where, and the exact line. */
export function hitlQuestion(request: HitlRequest): string {
  // OP #97576: 승인 문안은 ask 콜백으로 외부 전송(telegram/pushcut)되므로 line 의 비밀을 가린다 —
  // TUI 승인 문안과 같은 maskApprovalCommandSecrets 합집합(#38865)을 쓴다. 제어문자·경로·명령 원문은 그대로(가림 리터럴 시험으로 고정).
  const { maskApprovalCommandSecrets } = require('../tui/seat-approval-policy.js') as typeof import('../tui/seat-approval-policy.js');
  return `els ${request.action}: ${request.reason}\n  by ${request.principal.id} (shown as ${request.from})\n  to ${request.target.workspace}/${request.target.pane}\n  line ${JSON.stringify(maskApprovalCommandSecrets(request.text))}\napprove? [y/N] `;
}

/** One local `els do` through the control door. Remote addresses skip this door. */
export async function controlledDo(deps: ControlledDoDeps, pane: string, text: string): Promise<ElsResult> {
  if (parseAddress(pane)?.host) return deps.send(pane, text, deps.from);
  const principal = cliPrincipal(deps.stateDir, deps.uid, deps.ownerUid);
  if ('refused' in principal) return { exitCode: 1, message: `els do: denied (${principal.refused})` };
  const target = await deps.lookup(pane);
  if (!target) return { exitCode: 1, message: `els do: unknown pane ${pane}` };
  const control = createControl({
    stateDir: deps.stateDir,
    now: deps.now,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    execute: async (input) => {
      const done = await deps.send(input.target.pane, input.text ?? '', deps.from);
      const queued = queuedCount(done.message);
      return { exitCode: done.exitCode, message: done.message, ...(queued !== undefined ? { queued } : {}) };
    },
    ...(deps.ask ? { hitl: async (request) => deps.ask!(hitlQuestion(request)) } : {}),
  });
  return outcomeToResult(await control.run({ principal, from: deps.from, action: 'do', target, text }));
}

/** `els input <pane> <text>` — OP 의 직접 자리 입력 (OP #17 OP-DIRECT-SEAT-INPUT): «⇢» 마커 없이 친 사람처럼 한 줄을
 *  Pane 에 타자한다. control 문 경유 — OP·RES-INFRA 만 통과한다. */
export async function controlledInput(deps: ControlledDoDeps, pane: string, text: string): Promise<ElsResult> {
  if (parseAddress(pane)?.host) return { exitCode: 1, message: 'els input: remote input requires authenticated destination control' };
  const principal = cliPrincipal(deps.stateDir, deps.uid, deps.ownerUid);
  if ('refused' in principal) return { exitCode: 1, message: `els input: denied (${principal.refused})` };
  const target = await deps.lookup(pane);
  if (!target) return { exitCode: 1, message: `els input: unknown pane ${pane}` };
  const control = createControl({
    stateDir: deps.stateDir,
    now: deps.now,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    execute: async (input) => {
      const done = await deps.send(input.target.pane, input.text ?? '', deps.from);
      const queued = queuedCount(done.message);
      return { exitCode: done.exitCode, message: done.message, ...(queued !== undefined ? { queued } : {}) };
    },
    ...(deps.ask ? { hitl: async (request) => deps.ask!(hitlQuestion(request)) } : {}),
  });
  return outcomeToResult(await control.run({ principal, from: deps.from, action: 'input', target, text }));
}


function outcomeToResult(outcome: ControlOutcome): ElsResult {
  if (!outcome.ok) return { exitCode: 1, message: outcome.message };
  return { exitCode: outcome.exitCode, message: outcome.message };
}

/** Pane lookup and allow-list name resolution from one journal. Names resolve to ids; ids stay ids. */
export function journalControl(journal: SpaceJournal): { readonly lookup: (ref: string) => Promise<ControlTarget | undefined>; readonly resolve: IdResolver } {
  const workspaceOf = (paneId: string): string | undefined => {
    const pane = journal.panes.find((row) => row.id === paneId);
    const tab = pane ? journal.tabs.find((row) => row.id === pane.tabId) : undefined;
    return tab ? journal.workspaces.find((row) => row.id === tab.workspaceId)?.id : undefined;
  };
  return {
    lookup: async (ref) => {
      const pane = findPane(journal, ref);
      const workspace = pane ? workspaceOf(pane.id) : undefined;
      if (!pane || !workspace) return undefined;
      return { workspace, pane: pane.id, shell: pane.kind === 'pty' };
    },
    resolve: {
      workspace: (ref) => journal.workspaces.find((row) => row.id === ref)?.id ?? journal.workspaces.find((row) => row.name === ref)?.id,
      pane: (ref) => journal.panes.find((row) => row.id === ref)?.id ?? findPane(journal, ref)?.id,
    },
  };
}

/** A person at a terminal. Anything other than y/yes, or silence until `timeoutMs`, does not approve. */
export function askHitlOnTerminal(timeoutMs: number, io: { readonly stdin: NodeJS.ReadStream; readonly stderr: NodeJS.WriteStream } = { stdin: process.stdin, stderr: process.stderr }): (question: string) => Promise<'approve' | 'deny' | 'timeout'> {
  return (question) => new Promise((resolve) => {
    if (!io.stdin.isTTY) { resolve('timeout'); return; }
    const rl = createInterface({ input: io.stdin, output: io.stderr });
    const timer = setTimeout(() => { rl.close(); resolve('timeout'); }, timeoutMs);
    rl.question(question, (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve(/^(y|yes)$/i.test(answer.trim()) ? 'approve' : 'deny');
    });
  });
}
