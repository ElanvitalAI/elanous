import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestIntakeItems, listIntakeItems, markIntakeItem } from '../intake-plane/items.js';
import { annotateIntakeLens } from '../intake-plane/lens.js';
import { runIntakeDigestCli } from './intake-cli.js';

const day = '2026-10-05';
const at = '2026-10-04T16:00:00Z';

test('runIntakeDigestCli sends one combined E1, GitHub and X Telegram message with injected lens verdicts, preserving the E1/news send decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-digest-cli-'));
  const note = join(root, 'e1.md');
  try {
    writeFileSync(note, '# E1\n\n## 한 줄 결론\nE1 노트의 실제 요약이다.\n');
    ingestIntakeItems(root, 'youtube', [{ title: 'E1 video', url: 'https://example.com/e1-video' }], at);
    ingestIntakeItems(root, 'github', [{ title: 'Repo one', text: 'A new agent feature', url: 'https://github.com/org/repo-one' }], at);
    ingestIntakeItems(root, 'x', [{ title: 'X signal', text: 'A trending AI tool', url: 'https://x.com/alice/status/12345' }], at);
    const items = listIntakeItems(root);
    const e1 = items.find((item) => item.title === 'E1 video')!;
    const github = items.find((item) => item.title === 'Repo one')!;
    const x = items.find((item) => item.title === 'X signal')!;
    markIntakeItem(root, e1.id, { status: 'absorbed', output: { kind: 'note', ref: note } }, at);
    const goals = join(root, 'intake', 'outbox', 'goals');
    mkdirSync(goals, { recursive: true });
    appendFileSync(join(goals, `${day}.jsonl`), JSON.stringify({ id: e1.id, fact: 'E1 video', current: 'No equivalent', url: e1.url }) + '\n');

    const seen: string[] = [];
    const judged: string[] = [];
    const sent: string[] = [];
    const deps = {
      root,
      annotateLens: async (lensRoot: string, lensDay: string) => {
        seen.push('lens');
        await annotateIntakeLens(lensRoot, lensDay, {
          now: () => at,
          judge: async ({ id }) => {
            judged.push(id);
            return {
              lensVerdict: id === e1.id ? '보강' : id === github.id ? '대체 후보' : '참고',
              why: id === e1.id ? '우리 E1 칸에 활용할 근거가 있다' : id === github.id ? '우리 에이전트 구현을 대체할 수 있다' : '오늘 흐름을 기록할 자료다',
              target: id === e1.id ? 'E1' : id === github.id ? '에이전트' : '트렌드',
            };
          },
        });
      },
      sendTelegram: async (text: string) => { seen.push('telegram'); sent.push(text); return true; },
    };
    expect(await runIntakeDigestCli({ telegram: true, day }, deps)).toEqual({ sent: true });
    expect(seen).toEqual(['lens', 'telegram']);
    expect(judged).toEqual([e1.id, github.id, x.id]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('흡수 1편 → 우리에게 닿는 것 1');
    expect(sent[0]).toContain('S 무엇: E1 노트의 실제 요약이다.');
    expect(sent[0]).toContain('C 우리에게 왜: 우리 E1 칸에 활용할 근거가 있다');
    expect(sent[0]).toContain('🔗 노트: [[e1]]');
    expect(sent[0]).toContain('GitHub 신규 (1)\n- [대체 후보] Repo one — https://github.com/org/repo-one');
    expect(sent[0]).toContain('X 트렌드 (1)\n- [참고] X signal — https://x.com/i/status/12345');

    // E2/E3 alone can appear in JSON but cannot turn an otherwise empty Telegram day into a send.
    const otherDay = '2026-10-06';
    ingestIntakeItems(root, 'github', [{ title: 'Tomorrow repo', url: 'https://github.com/org/tomorrow' }], '2026-10-05T16:00:00Z');
    expect(await runIntakeDigestCli({ telegram: true, day: otherDay }, deps)).toEqual({ empty: true });
    expect(sent).toHaveLength(1);
    expect(seen).toEqual(['lens', 'telegram', 'lens']);
    expect(judged).toContain(listIntakeItems(root).find((item) => item.title === 'Tomorrow repo')!.id);

    // X 만 있는 날도 같다 — E3 하나로는 빈 날을 보내지 않는다.
    const xOnlyDay = '2026-10-08';
    ingestIntakeItems(root, 'x', [{ title: 'X only day', url: 'https://x.com/bob/status/67890' }], '2026-10-07T16:00:00Z');
    expect(await runIntakeDigestCli({ telegram: true, day: xOnlyDay }, deps)).toEqual({ empty: true });
    expect(sent).toHaveLength(1);
    expect(judged).toContain(listIntakeItems(root).find((item) => item.title === 'X only day')!.id);

    const newsDay = '2026-10-07';
    const lensDir = join(root, 'intake', 'outbox', 'lens');
    mkdirSync(lensDir, { recursive: true });
    appendFileSync(join(lensDir, `${newsDay}.jsonl`), JSON.stringify({
      title: 'News only', url: 'https://example.com/news', summary: ['New finding'], implication: ['Check relevance'],
    }) + '\n');
    expect(await runIntakeDigestCli({ telegram: true, day: newsDay }, deps)).toEqual({ sent: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('📰 News only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('separate-process intake digest --json reads E1, GitHub and X from ELANOUS_STATE_DIR', () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-digest-json-'));
  const cleanup: string[] = [root];
  try {
    ingestIntakeItems(root, 'github', [{ title: 'Repo JSON', url: 'https://github.com/org/json-repo' }], at);
    ingestIntakeItems(root, 'x', [{ title: 'X JSON', url: 'https://x.com/alice/status/123456' }], at);
    ingestIntakeItems(root, 'youtube', [{ title: 'E1 JSON', url: 'https://example.com/e1-json' }], at);
    const e1 = listIntakeItems(root).find((item) => item.title === 'E1 JSON')!;
    markIntakeItem(root, e1.id, { status: 'absorbed', output: { kind: 'note', ref: join(root, 'e1.md') } }, at);
    const lensDir = join(root, 'intake', 'outbox', 'lens');
    mkdirSync(lensDir, { recursive: true });
    const github = listIntakeItems(root).find((item) => item.title === 'Repo JSON')!;
    writeFileSync(join(lensDir, `${day}.jsonl`), JSON.stringify({ id: github.id, lensVerdict: '보강', why: '우리 구현에 새로운 근거가 된다', target: '에이전트' }) + '\n');
    // 항목은 ELANOUS_STATE_DIR(root)에만 있다. --test 를 주지 않는다(실측: --test 가 있으면 CLI 는 ELANOUS_STATE_DIR 를 읽지 않는다).
    // cwd·HOME 은 빈 폴더로 둔다 — 작업 트리 파생 test 우주나 운영 ~/.elanous 로 새지 않게.
    const decoy = mkdtempSync(join(tmpdir(), 'intake-digest-json-decoy-'));
    cleanup.push(decoy);
    const cli = spawnSync(process.execPath, [join(import.meta.dir, '../../bin/elanous.mjs'), 'intake', 'digest', '--day', day, '--json'], {
      cwd: decoy, encoding: 'utf8', timeout: 110_000,
      env: { ...process.env, HOME: decoy, ELANOUS_STATE_DIR: root, ELANOUS_SUPPRESS_XDG_WARNING: '1' },
    });
    expect(cli.status, cli.stderr).toBe(0);
    const json = JSON.parse(cli.stdout) as { absorbed: Array<{ id: string }>; githubNew: Array<{ title: string; verdict: string }>; xTrends: Array<{ title: string; verdict: string }> };
    expect(json.absorbed.map((item) => item.id)).toEqual([e1.id]);
    expect(json.githubNew).toMatchObject([{ title: 'Repo JSON', verdict: '보강' }]);
    expect(json.xTrends).toMatchObject([{ title: 'X JSON', verdict: '판정 대기' }]);
  } finally { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
