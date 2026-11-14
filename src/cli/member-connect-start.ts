import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { generatePkcePair } from '../oauth/pkce.js';

const ORIGIN = 'https://api.elanous.ai';
const ID = /^[A-Za-z0-9_-]{24}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;

/** Fixed local stages only: never carry upstream messages, URLs, or response bodies. */
export type MemberConnectFailureCode = 'start-unavailable' | 'poll-unavailable'
  | 'approval-refused' | 'approval-expired' | 'approval-invalid';

export class MemberConnectStageError extends Error {
  constructor(readonly code: MemberConnectFailureCode) {
    super(code === 'start-unavailable' ? 'member approval start unavailable' : 'member connect failed');
    this.name = 'MemberConnectStageError';
  }
}

export interface MemberConnectStartOptions {
  readonly configDir: string;
  readonly consumeHandoff: (path: string) => Promise<void>;
  readonly output: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Print one approval URL, then consume a private file only after browser approval. */
export async function startApprovedMemberConnect(options: MemberConnectStartOptions): Promise<void> {
  if (!isAbsolute(options.configDir)) throw new Error('invalid member config directory');
  try { mkdirSync(options.configDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('member config directory unavailable');
  }
  const directory = lstatSync(options.configDir);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())
    || (directory.mode & 0o022) !== 0) throw new Error('unsafe member config directory');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const { verifier, challenge, state } = generatePkcePair();
  const pollSecret = randomBytes(32).toString('base64url');
  let start: Response;
  try { start = await fetchImpl(`${ORIGIN}/v1/members/connect/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ state, codeChallenge: challenge, pollSecret }),
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  }); } catch { throw new MemberConnectStageError('start-unavailable'); }
  if (start.status !== 201) throw new MemberConnectStageError('start-unavailable');
  let started: { approvalUrl?: unknown; id?: unknown; userCode?: unknown };
  try { started = await start.json(); } catch { throw new MemberConnectStageError('approval-invalid'); }
  if (!started || typeof started.id !== 'string' || !ID.test(started.id) || typeof started.approvalUrl !== 'string'
    || typeof started.userCode !== 'string' || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(started.userCode)) {
    throw new MemberConnectStageError('approval-invalid');
  }
  let approvalUrl: URL;
  try { approvalUrl = new URL(started.approvalUrl); } catch { throw new MemberConnectStageError('approval-invalid'); }
  if (approvalUrl.origin !== ORIGIN || approvalUrl.pathname !== '/v1/members/connect/approve'
    || approvalUrl.username || approvalUrl.password || approvalUrl.hash
    || approvalUrl.searchParams.getAll('id').length !== 1 || approvalUrl.searchParams.get('id') !== started.id
    || [...approvalUrl.searchParams.keys()].some(key => key !== 'id')) {
    throw new MemberConnectStageError('approval-invalid');
  }
  options.output(`로그인된 본인 브라우저에서 이 주소를 열고 TUI 연결을 승인하세요: ${approvalUrl.toString()}`);
  options.output(`브라우저에 직접 입력할 확인 코드: ${started.userCode}`);
  const deadline = now() + 120_000;
  while (now() < deadline) {
    let result: Response;
    try { result = await fetchImpl(`${ORIGIN}/v1/members/connect/poll?id=${started.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pollSecret }), credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    }); } catch { throw new MemberConnectStageError('poll-unavailable'); }
    if (result.status === 202) { await sleep(2_000); continue; }
    if (result.status === 401 || result.status === 403) throw new MemberConnectStageError('approval-refused');
    if (result.status === 410) throw new MemberConnectStageError('approval-expired');
    if (result.status !== 200) throw new MemberConnectStageError('poll-unavailable');
    let approved: { code?: unknown; state?: unknown };
    try { approved = await result.json(); } catch { throw new MemberConnectStageError('approval-invalid'); }
    if (!approved || typeof approved.code !== 'string' || !CODE.test(approved.code) || approved.state !== state) {
      throw new MemberConnectStageError('approval-invalid');
    }
    const handoff = join(options.configDir, `.member-connect-handoff-${started.id}.json`);
    writeFileSync(handoff, JSON.stringify({ code: approved.code, state, codeVerifier: verifier }),
      { flag: 'wx', mode: 0o600 });
    try { await options.consumeHandoff(handoff); }
    finally { unlinkSync(handoff); }
    return;
  }
  throw new MemberConnectStageError('approval-expired');
}
