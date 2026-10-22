import { test, expect, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePrManager } from './pr-manager.js';

setDefaultTimeout(30_000);

function proof(oldCard: string | null, newCard: string, bound = false) {
  const root = mkdtempSync(join(tmpdir(), 'tc-samecell-proof-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  const calls = join(root, 'gh-calls.jsonl');
  mkdirSync(bin);
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, ['init', '--bare', '--initial-branch=main', origin]);
  git(root, ['clone', origin, work]);
  git(work, ['config', 'user.name', 'TC Proof']);
  git(work, ['config', 'user.email', 'tc-proof@example.test']);
  writeFileSync(join(work, 'base.txt'), 'base\n');
  git(work, ['add', '.']); git(work, ['commit', '-m', 'base']); git(work, ['push', 'origin', 'main']);
  git(work, ['checkout', '-b', 'old-branch']);
  writeFileSync(join(work, 'old.txt'), 'old\n');
  git(work, ['add', '.']); git(work, ['commit', '-m', 'old']); git(work, ['push', 'origin', 'old-branch']);
  const oldHead = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', 'main']); git(work, ['checkout', '-b', 'new-branch']);
  writeFileSync(join(work, 'new.txt'), 'new\n');
  const oldBody = `칸: PROVE-SAMECELL${oldCard ? `\n카드: ${oldCard}` : ''}`;
  const gh = `#!/usr/bin/env python3
import json,os,sys
a=sys.argv[1:]
with open(os.environ['TC_GH_CALLS'],'a') as f:f.write(json.dumps(a)+'\\n')
head=os.environ['TC_PR_HEAD']; body=os.environ['TC_PR_BODY']; url='https://github.com/o/r/pull/7'
if a[:3]==['api','--paginate','--slurp'] and '/pulls?' in a[3]:
 print(json.dumps([[{'number':7,'state':'open','draft':True,'head':{'ref':'old-branch','sha':head},'labels':[],'body':body,'title':'old','updated_at':'2026-10-21T00:00:00Z'}]]))
elif a[:3]==['api','--paginate','--slurp'] and '/files?' in a[3]:
 print(json.dumps([[{'filename':'old.txt'}]]))
elif a[:2]==['pr','list']:
 print(json.dumps([{'number':7,'changedFiles':1,'files':[{'path':'old.txt'}]}]))
elif a[:2]==['pr','view']:
 print(json.dumps({'state':'OPEN','headRefOid':head,'headRefName':'old-branch','body':body,'isCrossRepository':False,'isDraft':True,'labels':[],'url':url}))
elif a[:2]==['pr','diff']:
 print('diff --git a/old.txt b/old.txt\\n--- a/old.txt\\n+++ b/old.txt\\n@@ -1 +1 @@\\n-old\\n+old')
elif a[:2]==['pr','edit']:
 print(url)
else:
 print('unexpected fake gh '+repr(a),file=sys.stderr);sys.exit(77)
`;
  const ghPath = join(bin, 'gh');
  writeFileSync(ghPath, gh); chmodSync(ghPath, 0o755);
  const saved = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    TC_GH_CALLS: process.env.TC_GH_CALLS, TC_PR_HEAD: process.env.TC_PR_HEAD, TC_PR_BODY: process.env.TC_PR_BODY,
    ELANOUS_HARNESS_SEAT: process.env.ELANOUS_HARNESS_SEAT,
    ELANOUS_TASK_BOUND_PR: process.env.ELANOUS_TASK_BOUND_PR,
    ELANOUS_TASK_CARD_ID: process.env.ELANOUS_TASK_CARD_ID };
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.TC_GH_CALLS = calls;
  process.env.TC_PR_HEAD = oldHead;
  process.env.TC_PR_BODY = oldBody;
  process.env.ELANOUS_HARNESS_SEAT = 'TC';
  process.env.ELANOUS_TASK_CARD_ID = newCard;
  if (bound) process.env.ELANOUS_TASK_BOUND_PR = '7'; else delete process.env.ELANOUS_TASK_BOUND_PR;
  try {
    const outcome = makePrManager().upsertPr({ branch: 'new-branch', worktreePath: work,
      title: 'new', body: `칸: PROVE-SAMECELL\n카드: ${newCard}`, commitMessage: 'new', base: 'main',
      runId: 'run-a1b2c3d4-1111-2222-3333-444444444444' });
    return { outcome, oldHead, remoteHead: git(work, ['ls-remote', '--exit-code', 'origin', 'refs/heads/old-branch']).split('\t')[0],
      calls: readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('H1 other card in same cell: production guard blocks before push and exposes its result', () => {
  const result = proof('ta-old', 'ta-new');
  expect(result.outcome).toMatchObject({ ok: false, reason: 'guard' });
  if (result.outcome.ok) throw new Error('expected guard refusal');
  expect(result.outcome.detail.includes('candidateCardId=ta-new')).toBe(true);
  expect(result.outcome.detail.includes('blockers=#7:ta-old')).toBe(true);
  expect(result.remoteHead).toBe(result.oldHead);
});

test('H2 same card in same cell: production reuse advances old PR branch', () => {
  const result = proof('ta-same', 'ta-same');
  expect(result.outcome).toMatchObject({ ok: true, reused: true, url: 'https://github.com/o/r/pull/7' });
  expect(result.remoteHead).not.toBe(result.oldHead);
});

test('ledger-bound markerless old PR is reused and an unbound old PR is refused', () => {
  const bound = proof(null, 'ta-new', true);
  expect(bound.outcome).toMatchObject({ ok: true, reused: true, url: 'https://github.com/o/r/pull/7' });
  expect(bound.remoteHead).not.toBe(bound.oldHead);
  const unbound = proof(null, 'ta-new');
  expect(unbound.outcome).toMatchObject({ ok: false, reason: 'guard' });
  expect(unbound.remoteHead).toBe(unbound.oldHead);
});

test('task card PR without a matching human marker stops before git or gh', () => {
  const saved = process.env.ELANOUS_TASK_CARD_ID;
  process.env.ELANOUS_TASK_CARD_ID = 'ta-new';
  try {
    for (const body of ['칸: PROVE-SAMECELL', '칸: PROVE-SAMECELL\n카드: ta-other',
      '칸: PROVE-SAMECELL\n카드: ta-new\n카드: ta-other']) {
      expect(makePrManager(() => { throw new Error('unexpected command'); }).upsertPr({
        branch: 'new-branch', worktreePath: '/unused', title: 'new', body, commitMessage: 'new',
      })).toMatchObject({ ok: false, reason: 'guard' });
    }
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_TASK_CARD_ID; else process.env.ELANOUS_TASK_CARD_ID = saved;
  }
});
