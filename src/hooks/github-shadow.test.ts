import { expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';
import { openMsgStore } from '../msg/msg-store.js';
import { startHookReceiver } from './receiver.js';
import { startPublicHookIngress } from './expose.js';
import { judgeGithubShadow, publicPrFileNames } from './github-shadow.js';

async function drained(queue: { count(): number }): Promise<void> {
  for (let i = 0; i < 200; i++) { if (queue.count() === 0) return; await Bun.sleep(10); }
  throw new Error('shadow queue did not drain');
}

test('the file risk rule sends sensitive paths to human-check, not accepted', () => {
  expect(judgeGithubShadow('Update hook', 'pull_request', ['src/hooks/receiver.ts']).verdict).toBe('human-check');
});

test('a sensitive mode-only PR change alongside a docs edit requires human-check', async () => {
  const sha = (digit: string) => digit.repeat(40);
  const base = [
    { path: 'src/hooks/receiver.ts', sha: sha('1'), type: 'blob', mode: '100644' },
    { path: 'docs/guide.md', sha: sha('2'), type: 'blob', mode: '100644' },
  ];
  const merge = [
    { ...base[0]!, mode: '100755' },
    { ...base[1]!, sha: sha('3') },
  ];
  const requests: string[] = [];
  const githubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    const path = String(url);
    requests.push(path);
    const response = path.endsWith('/pulls/4')
      ? { number: 4, merge_commit_sha: sha('e'), base: { sha: sha('a'), repo: { full_name: 'ElanvitalAI/elanous' } }, head: { sha: sha('b') } }
      : path.endsWith(`/git/commits/${sha('a')}`) ? { tree: { sha: sha('c') } }
      : path.endsWith(`/git/commits/${sha('e')}`) ? { sha: sha('e'), parents: [{ sha: sha('a') }, { sha: sha('b') }], tree: { sha: sha('d') } }
      : path.includes(`/git/trees/${sha('c')}`) ? { sha: sha('c'), truncated: false, tree: base }
      : path.includes(`/git/trees/${sha('d')}`) ? { sha: sha('d'), truncated: false, tree: merge }
      : undefined;
    return response ? Response.json(response) : new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  const files = await publicPrFileNames(4, githubFetch);
  expect(files).toEqual(['src/hooks/receiver.ts', 'docs/guide.md']);
  expect(judgeGithubShadow('Improve docs', 'pull_request', files).verdict).toBe('human-check');
  expect(requests).toHaveLength(5);
});

test('signed public PR events become accepted, rejected, human-check shadow judgments and local candidate cards with zero external writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-shadow-'));
  const requests: Array<{ url: string; method: string }> = [];
  let forwards = 0;
  let wakes = 0;
  const sha = (digit: string) => digit.repeat(40);
  const githubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET' });
    const path = String(url);
    const tree = (id: string, entries: Array<{ path: string; sha: string; mode?: string }>) => Response.json({ sha: sha(id), truncated: false,
      tree: entries.map(entry => ({ ...entry, type: 'blob', mode: entry.mode ?? '100644' })) });
    const baseEntries = [{ path: 'src/hooks/receiver.ts', sha: sha('2') }]; // unchanged sensitive path in the safe PR
    const prs = [
      { number: 1, merge: 'e', head: 'b', tree: '7', changed: 'docs/guide.md' },
      { number: 3, merge: 'f', head: 'c', tree: '8', changed: 'docs/guide.md' },
      { number: 4, merge: '9', head: '4', tree: '5', changed: 'package.json' },
      { number: 5, merge: '6', head: '0', tree: '3', changed: '.github/actions/build/action.yml' },
    ];
    const pr = prs.find(item => path.endsWith(`/pulls/${item.number}`));
    if (pr) return Response.json({ number: pr.number, merge_commit_sha: sha(pr.merge),
      base: { sha: sha('a'), repo: { full_name: 'ElanvitalAI/elanous' } }, head: { sha: sha(pr.head) } });
    if (path.endsWith(`/git/commits/${sha('a')}`)) return Response.json({ tree: { sha: sha('d') } });
    const commit = prs.find(item => path.endsWith(`/git/commits/${sha(item.merge)}`));
    if (commit) return Response.json({ sha: sha(commit.merge), parents: [{ sha: sha('a') }, { sha: sha(commit.head) }],
      tree: { sha: sha(commit.tree) } });
    if (path.includes(`/git/trees/${sha('d')}`)) return tree('d', baseEntries);
    const merged = prs.find(item => path.includes(`/git/trees/${sha(item.tree)}`));
    if (merged) return tree(merged.tree, [
      ...(merged.number === 3 ? [{ ...baseEntries[0]!, mode: '100755' }] : baseEntries),
      { path: merged.changed, sha: sha('1') },
    ]);
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  const receiver = startHookReceiver({ port: 0, root, secrets: { github: 'private-key' }, githubFetch,
    forward: async () => { forwards++; return 204; }, wakeSeat: async () => { wakes++; }, retryBaseMs: 10 });
  const ingress = startPublicHookIngress(receiver.url, 0, root);
  const send = (number: number, title: string, body = '', delivery = randomUUID()) => {
    const payload = JSON.stringify({ action: 'opened', number, repository: { full_name: 'ElanvitalAI/elanous' },
      pull_request: { number, title, body, html_url: `https://github.com/ElanvitalAI/elanous/pull/${number}`, user: { login: 'contributor' } } });
    return fetch(new URL('/hooks/github', ingress.url), { method: 'POST', body: payload,
      headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': delivery,
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', 'private-key').update(payload).digest('hex')}` } });
  };
  try {
    const delivery = randomUUID();
    expect((await send(1, 'Fix user guide https://docs.example/guide', 'Repro: https://example.org/steps', delivery)).status).toBe(200);
    expect((await send(1, 'Fix user guide https://docs.example/guide', 'Repro: https://example.org/steps', delivery)).status).toBe(200);
    expect((await send(2, 'Prize offer', 'Crypto giveaway https://spam.example')).status).toBe(200);
    expect((await send(3, 'Update hook')).status).toBe(200);
    expect((await send(4, 'Update package config')).status).toBe(200);
    expect((await send(5, 'Update build action')).status).toBe(200);
    await drained(receiver.queue);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.db.query('SELECT item_number, verdict FROM github_shadow_judgments ORDER BY item_number').all()).toEqual([
        { item_number: 1, verdict: 'accepted' }, { item_number: 2, verdict: 'rejected' }, { item_number: 3, verdict: 'human-check' },
        { item_number: 4, verdict: 'human-check' }, { item_number: 5, verdict: 'human-check' },
      ]);
      expect(store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hook_work_cards'").get()).toBeNull();
      expect(store.listByRecipient('OP')).toEqual([]);
    } finally { store.close(); }
    const cards = new CardStore(root);
    try {
      expect(cards.listCards().map(card => [card.goalId, card.sections[0]?.owner,
        JSON.parse(card.sections[0]!.content).candidate]).sort()).toEqual([
        ['github:ElanvitalAI/elanous:pull_request:1', 'steward', 'decision-card'],
        ['github:ElanvitalAI/elanous:pull_request:2', 'steward', 'intake-only'],
        ['github:ElanvitalAI/elanous:pull_request:3', 'steward', 'decision-card'],
        ['github:ElanvitalAI/elanous:pull_request:4', 'steward', 'decision-card'],
        ['github:ElanvitalAI/elanous:pull_request:5', 'steward', 'decision-card'],
      ]);
    } finally { cards.close(); }
    expect(requests).toHaveLength(20);
    expect(requests.every(request => request.method === 'GET' && request.url.startsWith('https://api.github.com/repos/ElanvitalAI/elanous/') && !request.url.includes('/files'))).toBe(true);
    expect(forwards).toBe(0);
    expect(wakes).toBe(0);
  } finally { ingress.stop(); receiver.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('existing signed Linear hooks still use their original forward boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-shadow-linear-'));
  const forwarded: string[] = [];
  const receiver = startHookReceiver({ port: 0, root, now: () => 1_700_000_000_000, secrets: { linear: 'key' }, retryBaseMs: 10,
    forward: async event => { forwarded.push(`${event.provider}:${event.eventId}`); return 204; },
    githubFetch: (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => { throw new Error('GitHub lookup forbidden for Linear'); }) as typeof fetch });
  try {
    const raw = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: 1_700_000_000_000,
      data: { id: 'issue-1', title: 'Existing task' } });
    expect((await fetch(new URL('/hooks/linear', receiver.url), { method: 'POST', body: raw,
      headers: { 'Linear-Signature': createHmac('sha256', 'key').update(raw).digest('hex'), 'Linear-Delivery': 'linear-1' } })).status).toBe(200);
    await drained(receiver.queue);
    expect(forwarded).toEqual(['linear:linear-1']);
  } finally { receiver.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('untrusted or unverifiable GitHub events cannot silently enter work or bypass human check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'github-shadow-deny-'));
  const receiver = startHookReceiver({ port: 0, root, secrets: { github: 'key' }, retryBaseMs: 10,
    githubFetch: (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => { throw new Error('offline'); }) as typeof fetch });
  try {
    const send = (kind: string, action: string, repo: string, number: number, signed: boolean) => {
      const body = JSON.stringify({ action, number, repository: { full_name: repo }, issue: { number, title: 'Request feature',
        body: 'Reproduce at https://example.org/repro', html_url: `https://github.com/ElanvitalAI/elanous/issues/${number}`, user: { login: 'user' } },
        pull_request: { number, title: 'Feature', html_url: `https://github.com/ElanvitalAI/elanous/pull/${number}`, user: { login: 'user' } } });
      return fetch(new URL('/hooks/github', receiver.url), { method: 'POST', body, headers: { 'X-GitHub-Event': kind,
        'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': signed ? `sha256=${createHmac('sha256', 'key').update(body).digest('hex')}` : 'bad' } });
    };
    expect((await send('pull_request', 'opened', 'ElanvitalAI/elanous', 9, false)).status).toBe(401);
    // Other repositories take E1b's private path (only review requests / failed checks become work) — an opened PR there is ignored, never shadow intake.
    expect((await send('pull_request', 'opened', 'other/repo', 9, true)).status).toBe(200);
    expect((await send('pull_request', 'closed', 'ElanvitalAI/elanous', 9, true)).status).toBe(200);
    expect((await send('pull_request', 'opened', 'ElanvitalAI/elanous', 9, true)).status).toBe(200);
    expect((await send('issues', 'opened', 'ElanvitalAI/elanous', 10, true)).status).toBe(200);
    await drained(receiver.queue);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { expect(store.db.query('SELECT item_number, verdict FROM github_shadow_judgments ORDER BY item_number').all()).toEqual([
      { item_number: 9, verdict: 'human-check' }, { item_number: 10, verdict: 'accepted' },
    ]); } finally { store.close(); }
  } finally { receiver.stop(); rmSync(root, { recursive: true, force: true }); }
});
