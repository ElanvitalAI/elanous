import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { generatePkcePair } from '../oauth/pkce.js';

const ORIGIN = 'https://api.elanous.ai';
const ID = /^[A-Za-z0-9_-]{24}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;

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
  const start = await fetchImpl(`${ORIGIN}/v1/members/connect/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ state, codeChallenge: challenge, pollSecret }),
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  });
  if (start.status !== 201) throw new Error('member approval start unavailable');
  const started = await start.json() as { approvalUrl?: unknown; id?: unknown; userCode?: unknown };
  if (typeof started.id !== 'string' || !ID.test(started.id) || typeof started.approvalUrl !== 'string'
    || typeof started.userCode !== 'string' || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(started.userCode)) {
    throw new Error('invalid member approval start');
  }
  const approvalUrl = new URL(started.approvalUrl);
  if (approvalUrl.origin !== ORIGIN || approvalUrl.pathname !== '/v1/members/connect/approve'
    || approvalUrl.username || approvalUrl.password || approvalUrl.hash
    || approvalUrl.searchParams.getAll('id').length !== 1 || approvalUrl.searchParams.get('id') !== started.id
    || [...approvalUrl.searchParams.keys()].some(key => key !== 'id')) {
    throw new Error('invalid member approval URL');
  }
  options.output(`로그인된 본인 브라우저에서 이 주소를 열고 TUI 연결을 승인하세요: ${approvalUrl.toString()}`);
  options.output(`브라우저에 직접 입력할 확인 코드: ${started.userCode}`);
  const deadline = now() + 120_000;
  while (now() < deadline) {
    const result = await fetchImpl(`${ORIGIN}/v1/members/connect/poll?id=${started.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ pollSecret }), credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (result.status === 202) { await sleep(2_000); continue; }
    if (result.status !== 200) throw new Error('member approval refused or expired');
    const approved = await result.json() as { code?: unknown; state?: unknown };
    if (typeof approved.code !== 'string' || !CODE.test(approved.code) || approved.state !== state) {
      throw new Error('invalid member approval response');
    }
    const handoff = join(options.configDir, `.member-connect-handoff-${started.id}.json`);
    writeFileSync(handoff, JSON.stringify({ code: approved.code, state, codeVerifier: verifier }),
      { flag: 'wx', mode: 0o600 });
    try { await options.consumeHandoff(handoff); }
    finally { unlinkSync(handoff); }
    return;
  }
  throw new Error('member approval expired');
}
