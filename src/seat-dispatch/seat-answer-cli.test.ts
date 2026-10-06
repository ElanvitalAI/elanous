import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';

const repo = join(import.meta.dir, '..', '..');

test('seat answer CLI distinguishes Telegram delivery, failure, missing target, missing token and other worker claims without repository logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-answer-actual-'));
  const preload = join(root, 'fake-telegram.ts');
  const requests = join(root, 'telegram-requests.jsonl');
  const open = () => new MsgStore(join(root, 'msg', 'messages.db'));
  writeFileSync(preload, `require(${JSON.stringify(join(repo, 'src', 'session', 'working-dir.ts'))}).initSessionWorkingDir(process.env.FAKE_CLI_CWD);
  globalThis.fetch = async (url, init) => {
    require('node:fs').appendFileSync(process.env.FAKE_TG_REQUESTS, JSON.stringify({url: String(url), body: JSON.parse(String(init.body))}) + '\\n');
    return Response.json(process.env.FAKE_TG_FAIL === '1' ? {ok:false, description:'fake rejected'} : {ok:true, result:{message_id:9}});
  };`);
  const store = open();
  const cliCwd = join(root, 'cli-cwd');
  mkdirSync(cliCwd);
  const logDir = join(cliCwd, '.elanous', 'debug');
  const repoLogDir = join(repo, 'log');
  const repoLogFiles = () => existsSync(repoLogDir) ? readdirSync(repoLogDir).sort() : [];
  const repoLogBefore = repoLogFiles();
  const logPositions = () => new Map((existsSync(logDir) ? readdirSync(logDir) : [])
    .filter(file => file.startsWith('debug-') && file.endsWith('.log'))
    .map(file => [file, statSync(join(logDir, file)).size] as const));
  type ReplyEvent = { category: string; event: string; data?: { id?: string; reason?: string; elapsedMs?: number | null } };
  const newEvents = (before: Map<string, number>): ReplyEvent[] => (existsSync(logDir) ? readdirSync(logDir) : [])
    .filter(file => file.startsWith('debug-') && file.endsWith('.log'))
    .flatMap(file => {
      const bytes = readFileSync(join(logDir, file));
      const offset = before.get(file) ?? 0;
      return bytes.subarray(offset <= bytes.length ? offset : 0).toString('utf8').split('\n')
        .filter(Boolean).map(line => JSON.parse(line) as ReplyEvent);
    });
  const eventsById = new Map<string, ReplyEvent[]>();
  const ids = ['success', 'failure', 'no-target', 'no-token', 'legacy', 'claimed', 'unrelated'];
  const now = Date.now();
  try {
    store.db.exec(`CREATE TABLE seat_asks (id TEXT PRIMARY KEY, seat TEXT NOT NULL, origin TEXT NOT NULL,
      deadline INTEGER NOT NULL, timeout_minutes INTEGER NOT NULL DEFAULT 120, status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT, answered_at INTEGER, asked_at INTEGER)`);
    for (const id of ids) {
      const origin = id === 'no-target' ? { channel: 'tui', clientId: 'elsewhere' }
        : { channel: 'telegram', chatId: 111, messageId: 456, threadId: 7, botId: '123' };
      store.db.query('INSERT INTO seat_asks (id, seat, origin, deadline, timeout_minutes, asked_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'TC', JSON.stringify(origin), now + 120_000, 2, id === 'legacy' ? null : now - 500);
    }
    store.db.query('UPDATE seat_asks SET answer = ?, answered_at = ? WHERE id = ?').run('다른 답', now - 200, 'unrelated');
    store.db.exec(`CREATE TABLE seat_ask_outbox (id TEXT PRIMARY KEY, origin TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', claim_until INTEGER NOT NULL DEFAULT 0, claim_token TEXT);
      CREATE TRIGGER claim_seat_answer_outbox AFTER INSERT ON seat_ask_outbox WHEN NEW.id = 'claimed'
      BEGIN UPDATE seat_ask_outbox SET claim_until = ${now + 60_000}, claim_token = 'other-worker' WHERE id = NEW.id; END`);
    const run = (id: string, env: Record<string, string> = {}) => {
      const before = logPositions();
      const result = Bun.spawnSync(['bun', '--preload', preload, join(repo, 'bin', 'elanous.mjs'), `--test=${root}`, 'seat', 'answer', id, '완료'], {
        cwd: repo, env: { ...process.env, NODE_ENV: '', FAKE_CLI_CWD: cliCwd, TELEGRAM_BOT_TOKEN: '123:fake', FAKE_TG_REQUESTS: requests, ...env },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(new TextDecoder().decode(result.stderr)).not.toContain('seat answer:');
      expect(result.exitCode).toBe(0);
      eventsById.set(id, newEvents(before).filter(event => event.category === 'seat.ask' && event.data?.id === id));
      return new TextDecoder().decode(result.stdout);
    };
    expect(run('success')).toMatch(/텔레그램 회신 전달: success · 지연 [1-9]\d*ms/);
    expect(run('failure', { FAKE_TG_FAIL: '1' })).toContain('텔레그램 회신 실패: failure · 회신 대기');
    expect((store.db.query('SELECT status FROM seat_asks WHERE id = ?').get('unrelated') as { status: string }).status).toBe('pending');
    expect(run('no-target')).toContain('전달 대상 없음: no-target (tui)');
    expect(run('no-token', { TELEGRAM_BOT_TOKEN: '' })).toContain('텔레그램 토큰 없음 (TELEGRAM_BOT_TOKEN): no-token');
    expect(run('legacy')).toContain('지연 미상');
    const claimedOutput = run('claimed');
    expect(claimedOutput).toContain('다른 작업자가 전달 중: claimed');
    expect(claimedOutput).not.toContain('전달 대상 없음');
    const posted = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { url: string; body: Record<string, unknown> });
    expect(posted).toHaveLength(3);
    expect(posted.map(({ body }) => body.text)).toEqual(ids.filter(id => ['success', 'failure', 'legacy'].includes(id)).map(id => `CTO 답변 (${id}): 완료`));
    expect(posted[0]!.body).toEqual({ chat_id: 111, text: 'CTO 답변 (success): 완료', reply_to_message_id: 456, message_thread_id: 7 });
    expect(posted.every(({ url }) => url.endsWith('/sendMessage'))).toBe(true);
    const records = store.db.query('SELECT id, answer, status FROM seat_asks ORDER BY id').all() as Array<{ id: string; answer: string | null; status: string }>;
    expect(Object.fromEntries(records.map(({ id, answer, status }) => [id, [answer, status]]))).toEqual({
      success: ['완료', 'answered'], failure: ['완료', 'answered'], legacy: ['완료', 'answered'],
      'no-target': ['완료', 'pending'], 'no-token': ['완료', 'pending'], claimed: ['완료', 'answered'], unrelated: ['다른 답', 'pending'],
    });
    expect(store.db.query('SELECT status, claim_token FROM seat_ask_outbox WHERE id = ?').get('claimed'))
      .toEqual({ status: 'pending', claim_token: 'other-worker' });
    expect(eventsById.get('success')?.some(event => event.event === 'reply-sent' && typeof event.data?.elapsedMs === 'number')).toBe(true);
    expect(eventsById.get('failure')?.some(event => event.event === 'reply-failed' && event.data?.reason === 'fake rejected')).toBe(true);
    expect(eventsById.get('no-token')?.some(event => event.event === 'reply-failed' && event.data?.reason === 'token-missing')).toBe(true);
    expect(eventsById.get('legacy')?.some(event => event.event === 'reply-sent' && event.data?.elapsedMs === null)).toBe(true);
    expect(eventsById.get('no-target')?.some(event => event.event === 'reply-no-target')).toBe(true);
    expect(eventsById.get('no-target')?.some(event => event.event === 'reply-sent')).toBe(false);
    expect(eventsById.get('claimed')?.some(event => event.event === 'reply-in-progress' && event.data?.reason === 'claimed-by-other-worker')).toBe(true);
    expect(eventsById.get('claimed')?.some(event => event.event === 'reply-no-target' || event.event === 'reply-sent')).toBe(false);
  } finally {
    store.close();
    try { expect(repoLogFiles()).toEqual(repoLogBefore); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 30_000);
