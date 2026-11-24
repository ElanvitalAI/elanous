// DOCS-SEARCH-INDEX-EMPTY — 「문서 색인이 0」 결함의 회귀 시험.
// 정적 import 만 쓴다(TEST-INTERFERENCE-RATCHET · 본문 안 동적 import 금지).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveKnowledgeDocsRoots } from './docs-roots.js';
import { docsIndexCount, hybridQueryKnowledge, ingestDocsCorpus, ingestDocsDir, openKnowledgeDb, type EmbedFn } from '../domains/knowledge.js';

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
