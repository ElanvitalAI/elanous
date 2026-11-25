// DOCS-SEARCH-INDEX-EMPTY — 「문서 색인이 0」 결함의 회귀 시험.
// 정적 import 만 쓴다(TEST-INTERFERENCE-RATCHET · 본문 안 동적 import 금지).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveKnowledgeDocsRoots } from './docs-roots.js';
import { docsIndexCount, hybridQueryKnowledge, ingestDocsCorpus, ingestDocsDir, openKnowledgeDb, type EmbedFn } from '../domains/knowledge.js';
import { configuredDocsRoots, docsIndexNotice, docsSearchFallback, formatFallbackHits } from '../cli/docs-cli.js';
import { fallbackDocsSearch, isLowConfidence } from './docs-search-fallback.js';
import { configuredLatestRepoRoots, normalizeConfiguredDocsRoot } from './docs-roots.js';

/** 결정론 임베딩 — 네트워크 없이 질의↔청크 의미 유사를 흉내 내는 토큰 뭉치 벡터. */
const fakeEmbed: EmbedFn = async (text) => {
  const vector = new Float32Array(64);
  for (const token of text.toLowerCase().split(/[^가-힣a-z0-9]+/)) {
    if (!token) continue;
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % 64;
    vector[h] = (vector[h] ?? 0) + 1;
  }
  return { vector, model: 'fake-embed-deterministic' };
};

/** 격리 좌석 상태(OPS-RULES) + 가짜 도구 체크아웃(conductor/plans) 픽스처. */
function fixture(): {
  root: string; state: string; seatState: string; opsRules: string;
  toolDocs: string; scriptUrl: string; env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), 'docs-search-index-'));
  const state = join(root, 'state');
  const seatState = join(state, 'seat-state');
  const opsRules = join(seatState, 'OPS', 'OPS-RULES.md');
  const toolHome = join(root, 'tool');
  const toolDocs = join(toolHome, 'docs');
  mkdirSync(join(seatState, 'OPS'), { recursive: true });
  mkdirSync(join(toolDocs, 'conductor'), { recursive: true });
  mkdirSync(join(toolDocs, 'plans'), { recursive: true });
  writeFileSync(join(toolHome, 'package.json'), JSON.stringify({ name: 'elanous' }));
  // §판정·증거 절에 «초록을 시뮬로 닫는 법» 행 — OPS-RULES 의 대표 행.
  writeFileSync(opsRules, [
    '# OPS-RULES',
    '',
    '## 판정·증거',
    '',
    '- 초록을 시뮬로 닫는 법 — GREEN 은 원격 node-b 초록 로그 원문을 증거로 남긴다.',
    '- 초록을 시뮬로 닫는 법 — 재현 명령과 exit 코드를 증거 줄에 적는다.',
    '- 판정은 pass 이면 초록으로 닫는다.',
    '',
  ].join('\n'));
  // FACTS 접두사는 KNOWN_PREFIXES 밖 — 도구 docs 순회 선정에서 탈락해 온 제2결함의 실체.
  writeFileSync(join(toolDocs, 'conductor', 'FACTS-DISTILLED.md'), [
    '# FACTS-DISTILLED',
    '',
    '## 증류 사실',
    '',
    '- 문서 색인은 mtime 증분으로 무변경 파일을 건너뛴다.',
    '',
  ].join('\n'));
  writeFileSync(join(toolDocs, 'plans', 'PLAN-knowledge-index.md'), [
    '# PLAN-knowledge-index',
    '',
    '- docs 색인 자가부트를 docs search 에 붙인다.',
    '',
  ].join('\n'));
  return {
    root,
    state,
    seatState,
    opsRules,
    toolDocs,
    scriptUrl: pathToFileURL(join(toolHome, 'scripts', 'knowledge-ingest.ts')).href,
    env: { ELANOUS_STATE_DIR: state },
  };
}

describe('DOCS-SEARCH-INDEX-EMPTY — 문서 색인 뿌리', () => {
  test('① 자동 감지에 현행 절 후보 3종(OPS-RULES·FACTS-DISTILLED·plans)이 포함된다', () => {
    const fx = fixture();
    const got = resolveKnowledgeDocsRoots({
      toolModuleUrl: fx.scriptUrl,
      toolDocsSegments: ['..', 'docs'],
      cwd: join(fx.root, 'work'),
      env: fx.env,
      readPackageName: () => 'elanous',
      gitRoot: () => undefined,
    });
    const paths = got.roots.map((r) => r.path);
    expect(paths).toContain(join(fx.seatState, 'OPS', 'OPS-RULES.md'));
    expect(paths).toContain(join(fx.toolDocs, 'conductor', 'FACTS-DISTILLED.md'));
    expect(paths).toContain(join(fx.toolDocs, 'plans'));
    const byPath = new Map(got.roots.map((r) => [r.path, r.source]));
    expect(byPath.get(join(fx.seatState, 'OPS', 'OPS-RULES.md'))).toBe('current-sections');
    expect(byPath.get(join(fx.toolDocs, 'conductor', 'FACTS-DISTILLED.md'))).toBe('current-sections');
    expect(byPath.get(join(fx.toolDocs, 'plans'))).toBe('current-sections');
  });

  test('② 파일 뿌리(OPS-RULES.md) 인제스트가 청크를 남기고 하이브리드 검색이 잡는다', async () => {
    const fx = fixture();
    const db = openKnowledgeDb(join(fx.root, 'knowledge.db'));
    try {
      const r = await ingestDocsDir(db, { dir: fx.opsRules, embed: fakeEmbed });
      expect(r.chunks).toBeGreaterThan(0); // 출처: #39964 인제스트 후 청크 0은 무색인=기능 상실 경계
      const matches = await hybridQueryKnowledge(db, '초록을 시뮬로 닫는 법', {
        kind: 'docs',
        k: 5,
        embed: fakeEmbed,
      });
      expect(matches.length).toBeGreaterThan(0); // 출처: #39964 하이브리드 검색 0건이면 인제스트 무의미 — 회수 하한
      expect(matches[0]!.source_ref).toBe(fx.opsRules);
    } finally {
      db.close();
    }
  });

  test('③ corpus 인제스트가 뿌리 전체를 순회해 docs 색인을 채운다', async () => {
    const fx = fixture();
    const db = openKnowledgeDb(join(fx.root, 'knowledge-corpus.db'));
    try {
      expect(docsIndexCount(db)).toBe(0);
      const r = await ingestDocsCorpus(db, {
        toolModuleUrl: fx.scriptUrl,
        toolDocsSegments: ['..', 'docs'],
        cwd: join(fx.root, 'work'),
        env: fx.env,
        embed: fakeEmbed,
        readPackageName: () => 'elanous',
        gitRoot: () => undefined,
      });
      expect(r.roots).toBe(4);
      expect(r.chunks).toBeGreaterThan(0); // 출처: #39964 인제스트 후 청크 0은 무색인=기능 상실 경계
      expect(docsIndexCount(db)).toBeGreaterThan(0); // 출처: #39964 색인 자가부트 계약 — 0이면 DOCS-SEARCH-INDEX-EMPTY 그대로
    } finally {
      db.close();
    }
  });
});

/** DOCS-SEARCH-CONDUCTOR 픽스처 — 접두가 taxonomy 밖인 conductor 정본 1장 ⊕ 그 이름·낱말을 본문에 흘리는 잡음 문서들. */
function conductorFixture(): { root: string; docs: string; target: string; opts: Parameters<typeof ingestDocsCorpus>[1] } {
  const root = mkdtempSync(join(tmpdir(), 'docs-search-conductor-'));
  const docs = join(root, 'repo', 'docs');
  mkdirSync(join(docs, 'conductor'), { recursive: true });
  const target = join(docs, 'conductor', 'WIDGET-THROTTLE-PLAN.md');
  writeFileSync(target, [
    '# 위젯 부하 줄이기 — 한 줄기 설계',
    '',
    '## 배경',
    '',
    '- 요청 큐가 밀리면 렌더 스레드가 막힌다.',
    '',
  ].join('\n'));
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(docs, `PLAN-noise-${i}-2026-11-0${i}.md`), [
      `# PLAN noise ${i}`,
      '',
      `- WIDGET-THROTTLE-PLAN 을 언급만 한다 · 위젯 부하 줄이기 이야기 ${i} · 위젯 위젯 부하 부하.`,
      '',
    ].join('\n'));
  }
  return {
    root,
    docs,
    target,
    opts: {
      docsRoots: [docs],
      env: { ELANOUS_STATE_DIR: join(root, 'state') },
      embed: fakeEmbed,
    },
  };
}

describe('DOCS-SEARCH-CONDUCTOR — 정본 설계 문서 색인·이름 검색', () => {
  test('④ 접두 taxonomy 밖 conductor 문서도 색인되고 파일명 질의는 그 문서가 1위', async () => {
    const fx = conductorFixture();
    const db = openKnowledgeDb(join(fx.root, 'knowledge.db'));
    try {
      await ingestDocsCorpus(db, fx.opts);
      const matches = await hybridQueryKnowledge(db, 'WIDGET-THROTTLE-PLAN', { kind: 'docs', k: 8, embed: fakeEmbed });
      expect(matches[0]!.source_ref).toBe(fx.target);
    } finally {
      db.close();
    }
  });

  test('⑤ 한국어 제목 질의는 그 문서가 상위 3 안', async () => {
    const fx = conductorFixture();
    const db = openKnowledgeDb(join(fx.root, 'knowledge.db'));
    try {
      await ingestDocsCorpus(db, fx.opts);
      const matches = await hybridQueryKnowledge(db, '위젯 부하 줄이기', { kind: 'docs', k: 8, embed: fakeEmbed });
      expect(matches.slice(0, 3).map((m) => m.source_ref)).toContain(fx.target);
    } finally {
      db.close();
    }
  });

  test('⑥ 새 파일을 더하면 다음 갱신 뒤 이름으로 잡힌다', async () => {
    const fx = conductorFixture();
    const db = openKnowledgeDb(join(fx.root, 'knowledge.db'));
    try {
      await ingestDocsCorpus(db, fx.opts);
      const added = join(fx.docs, 'conductor', 'LANTERN-RELAY.md');
      writeFileSync(added, '# 랜턴 중계 정본\n\n- 새로 생긴 설계.\n');
      const before = await hybridQueryKnowledge(db, 'LANTERN-RELAY', { kind: 'docs', k: 8, embed: fakeEmbed });
      expect(before.map((m) => m.source_ref)).not.toContain(added);
      const second = await ingestDocsCorpus(db, fx.opts);
      expect(second.files).toBe(1);
      const after = await hybridQueryKnowledge(db, 'LANTERN-RELAY', { kind: 'docs', k: 8, embed: fakeEmbed });
      expect(after[0]!.source_ref).toBe(added);
    } finally {
      db.close();
    }
  });

  test('⑦ 상한을 넘친 변경은 pending 으로 남고 안내 한 줄이 나온다', async () => {
    const fx = conductorFixture();
    const db = openKnowledgeDb(join(fx.root, 'knowledge.db'));
    try {
      const first = await ingestDocsCorpus(db, { ...fx.opts, maxFiles: 2 });
      expect(first.files).toBe(2);
      expect(first.pending).toBe(5);
      expect(docsIndexNotice(first)).toContain('index stale — 5 changed doc(s) not indexed yet');
      const rest = await ingestDocsCorpus(db, fx.opts);
      expect(rest.pending).toBe(0);
      expect(docsIndexNotice(rest)).toBeNull();
      expect(docsIndexNotice({ ...rest, rootPaths: [join(fx.root, 'nowhere')] }))
        .toBe('docs search: no docs/conductor in the index roots — run from a repo worktree or set knowledge.docsRoots');
    } finally {
      db.close();
    }
  });
});

/** 11-25 — 설정에 «저장소 뿌리»(latest)를 적은 경우: 임시 config ⊕ 임시 저장소. */
function repoRootFixture(): { root: string; repo: string; target: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'docs-search-repo-root-'));
  const repo = join(root, 'latest');
  mkdirSync(join(repo, 'docs', 'conductor'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  const target = join(repo, 'docs', 'conductor', 'JUDGE-LOAD-REDUCTION.md');
  writeFileSync(target, ['# JUDGE-LOAD-REDUCTION', '', '- 판정국 부하를 줄이는 설계.', ''].join('\n'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ knowledge: { docsRoots: [repo] } }));
  return { root, repo, target, configPath };
}

describe('DOCS-SEARCH-ROOTS — 설정 뿌리가 저장소 뿌리여도 이긴다(11-25)', () => {
  test('⑦ 임시 config 의 저장소 뿌리 → docs 로 정규화 · conductor 판정 통과 · JUDGE-LOAD-REDUCTION 색인', async () => {
    const fx = repoRootFixture();
    const raw = JSON.parse(readFileSync(fx.configPath, 'utf8'));
    const configured = configuredDocsRoots(raw);
    expect(configured).toEqual([fx.repo]);
    expect(normalizeConfiguredDocsRoot(fx.repo)).toBe(join(fx.repo, 'docs'));
    const resolved = resolveKnowledgeDocsRoots({ docsRoots: configured });
    expect(resolved.source).toBe('config');
    expect(resolved.roots.map((r) => r.path)).toEqual([join(fx.repo, 'docs')]);
    const db = openKnowledgeDb(join(fx.root, 'knowledge.db'));
    try {
      const refresh = await ingestDocsCorpus(db, { docsRoots: configured!, embed: fakeEmbed });
      expect(docsIndexNotice(refresh)).toBeNull();
      const matches = await hybridQueryKnowledge(db, 'JUDGE-LOAD-REDUCTION', { kind: 'docs', k: 5, embed: fakeEmbed });
      expect(matches[0]!.source_ref).toBe(fx.target);
    } finally {
      db.close();
    }
  });

  test('⑧ docs 디렉터리를 직접 적은 설정은 그대로 · 설정 없음은 undefined · latest 저장소 뿌리 추출', () => {
    const fx = repoRootFixture();
    expect(normalizeConfiguredDocsRoot(join(fx.repo, 'docs'))).toBe(join(fx.repo, 'docs'));
    expect(configuredDocsRoots({})).toBeUndefined();
    expect(configuredDocsRoots({ knowledge: { docsRoots: [] } })).toEqual([]);
    expect(configuredLatestRepoRoots([fx.repo])).toEqual([fx.repo]);
    expect(configuredLatestRepoRoots([join(fx.repo, 'docs')])).toEqual([fx.repo]);
  });

  test('⑨ 폴백 — 색인 0건·의미만이면 이름 ⊕ 본문으로 찾고 «(fallback)» 표시', () => {
    const fx = repoRootFixture();
    writeFileSync(join(fx.repo, 'docs', 'conductor', 'OTHER.md'), '# other\n\n- judge-load-reduction 언급\n');
    expect(isLowConfidence([])).toBe(true);
    expect(isLowConfidence([{ matchedBy: 'vector' }])).toBe(true);
    expect(isLowConfidence([{ matchedBy: 'vector' }, { matchedBy: 'fts' }])).toBe(false);
    const hits = fallbackDocsSearch('judge-load-reduction', [join(fx.repo, 'docs')]);
    expect(hits[0]!.path).toBe(fx.target);
    expect(hits[0]!.nameHits).toBe(1);
    expect(hits.map((h) => h.path)).toContain(join(fx.repo, 'docs', 'conductor', 'OTHER.md'));
    expect(formatFallbackHits(hits)[0]).toStartWith('(fallback) name');
    expect(fallbackDocsSearch('zzz-no-such-token', [join(fx.repo, 'docs')])).toEqual([]);
  });

  test('⑩ 진짜 빗나감(색인 0 ⊕ 폴백 0)만 docs.search-miss 로 남는다', () => {
    const fx = repoRootFixture();
    const roots = [join(fx.repo, 'docs')];
    const logged: unknown[][] = [];
    const log = (...a: unknown[]) => { logged.push(a); };
    expect(docsSearchFallback('zzz-no-such-token', [], roots, 8, log)).toEqual([]);
    expect(logged).toEqual([['docs', 'search-miss', { query: 'zzz-no-such-token', roots, hits: 0 }]]);
    logged.length = 0;
    expect(docsSearchFallback('judge-load-reduction', [], roots, 8, log).length).toBeGreaterThan(0);
    expect(docsSearchFallback('anything', [{ matchedBy: 'fts' }], roots, 8, log)).toEqual([]);
    expect(logged).toEqual([]);
  });
});
