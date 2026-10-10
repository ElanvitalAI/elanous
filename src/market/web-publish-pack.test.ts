// web-publish 공식 팩 — run-step 의 workdir 가두기 회귀 시험(가벼운 판 · 본격 보안 검토는 별도 칸).
import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insideWorkspace, isPublicHttpsUrl, mediaDigest, siteDigest } from '../../packs/web-publish/graphs/run-step.js';
import { decideGraphApproval, lastJsonObject, runGraph } from '../graph-runner/runner.js';

const GRAPHS = join(import.meta.dir, '..', '..', 'packs', 'web-publish', 'graphs');
const STEP = join(GRAPHS, 'run-step.ts');
const dirs: string[] = [];
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'web-publish-test-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 발행 단위 시험용 문맥: 승인 ⊕ QA 가 본 site/ 지문(실제 런에서는 qa 단계가 남긴다). */
const released = (ws: string, approval: Record<string, unknown> = { outcome: 'approved' }) =>
  ({ approve_release: approval, audit_media: { outcome: 'skip', media_digest: mediaDigest(ws) }, qa: { outcome: 'ok', site_digest: siteDigest(join(ws, 'site')) } });

function step(name: string, ws: string, outputs: Record<string, unknown> = {}, dry = false, target = 'folder'): Record<string, unknown> {
  const ctx = join(ws, '..', `${ws.split('/').pop()}-ctx.json`);
  writeFileSync(ctx, JSON.stringify({ input: { business: 'b', goal: 'g', workspace: ws, publish_target: target, reference_urls: ['https://example.com/'] }, outputs }));
  dirs.push(ctx);
  const proc = Bun.spawnSync([process.execPath, STEP, name, ...(dry ? ['--dry'] : [])], { env: { ...process.env, ELANOUS_GRAPH_CONTEXT: ctx, ELANOUS_GRAPH_DRY_RUN: dry ? '1' : '0' } });
  const lines = new TextDecoder().decode(proc.stdout).trim().split('\n');
  return JSON.parse(lines.at(-1)!);
}

test('insideWorkspace refuses absolute paths, any `..` segment, and links that leave the workspace', () => {
  const ws = temp();
  const outside = temp();
  mkdirSync(join(ws, 'media'));
  writeFileSync(join(ws, 'media', 'a.png'), 'x');
  symlinkSync(join(outside), join(ws, 'media', 'escape'));
  expect(insideWorkspace(ws, 'media/a.png')).toBe(join(ws, 'media', 'a.png'));
  expect(insideWorkspace(ws, '/etc/hosts')).toBeUndefined();
  expect(insideWorkspace(ws, '../x.png')).toBeUndefined();
  expect(insideWorkspace(ws, 'media/../media/a.png')).toBeUndefined();
  expect(insideWorkspace(ws, 'media/escape/a.png')).toBeUndefined();
  expect(insideWorkspace(ws, '')).toBeUndefined();
});

test('audit-media step refuses a manifest that points outside the workspace before running the audit script', () => {
  const ws = temp();
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [
    { id: 'a', kind: 'image', file: 'media/../../secret.png', role: 'mood', rights: 'own' },
  ] }));
  const out = step('audit-media', ws);
  expect(out.outcome).toBe('fail');
  expect(String(out.error)).toContain('workdir 밖');
});

test('audit-media step refuses a report path that is a link', () => {
  const ws = temp();
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [{ id: 'a', kind: 'image', file: 'a.png', role: 'mood', rights: 'own' }] }));
  writeFileSync(join(ws, 'a.png'), 'x');
  symlinkSync(join(temp(), 'report.json'), join(ws, 'media-audit.json'));
  const out = step('audit-media', ws);
  expect(out.outcome).toBe('fail');
  expect(String(out.error)).toContain('media-audit.json');
});

test('publish step (unit · approval output injected — the real approve ⊕ resume path is the run test below) refuses without approval and refuses linked targets', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  expect(step('publish', ws).outcome).toBe('fail');
  const approved = released(ws);
  mkdirSync(join(ws, 'out'));
  symlinkSync(join(ws, 'site'), join(ws, 'out', 'site'));
  const linked = step('publish', ws, approved);
  expect(linked.outcome).toBe('fail');
  expect(readFileSync(join(ws, 'site', 'index.html'), 'utf8')).toBe('<h1>x</h1>');
  rmSync(join(ws, 'out'), { recursive: true });
  symlinkSync(ws, join(ws, 'out'));
  expect(step('publish', ws, approved).outcome).toBe('fail');
  expect(readFileSync(join(ws, 'site', 'index.html'), 'utf8')).toBe('<h1>x</h1>');
  rmSync(join(ws, 'out'));
  const ok = step('publish', ws, approved);
  expect(ok.outcome).toBe('ok');
  expect(ok.target).toBe('folder');
});

test('a real run pauses at both approvals and publishes to the folder only after graph approval ⊕ resume', async () => {
  const ws = temp();
  const root = temp();
  mkdirSync(join(ws, 'strategy'));
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'qa'));
  writeFileSync(join(ws, 'strategy', 'claims.json'), JSON.stringify([{ claim: 'Quotes by photo', grade: '제안', public: true }]));
  writeFileSync(join(ws, 'strategy', 'page-map.json'), JSON.stringify([{ page: 'home', question: 'q', answer: 'a', evidence: 'e', related: [], next_action: 'quote' }]));
  writeFileSync(join(ws, 'DESIGN.md'), '# Design\n');
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>Bindery</h1>');
  writeFileSync(join(ws, 'site', 'tokens.css'), '/* generated from DESIGN.md */\n');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [] }));
  mkdirSync(join(ws, 'motion'));
  writeFileSync(join(ws, 'motion', 'motion-plan.json'), JSON.stringify([{ element: 'hero', kind: '구간 진입 등장', reduced_motion: 'static, text visible', mobile: 'same order' }]));
  writeFileSync(join(ws, 'qa', 'qa-report.json'), JSON.stringify({ ruler: 'manual', widths: { 390: 'pass', 768: 'pass', 1280: 'pass' },
    reduced_motion_content_visible: true, evidence: { emulator: 'pass', webkit: 'unverified', real_device: 'unverified' } }));
  const graph = join(GRAPHS, 'web-publish.yaml');
  const input = { business: 'A fictional bindery', goal: 'quote requests', workspace: ws, publish_target: 'folder' };
  const first = await runGraph(graph, { runId: 'webpub-approvals', input, deps: { root } });
  expect(first.status).toBe('awaiting-approval');
  expect(first.pending?.nodeId).toBe('approve_plan');
  expect(existsSync(join(ws, 'out', 'site'))).toBe(false);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'tester', root);
  const second = await runGraph(graph, { resumeRunId: first.runId, deps: { root } });
  expect(second.pending?.nodeId).toBe('approve_release');
  expect(existsSync(join(ws, 'out', 'site'))).toBe(false);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'tester', root);
  const final = await runGraph(graph, { resumeRunId: first.runId, deps: { root } });
  expect(final.status).toBe('done');
  const publish = final.nodes.find(node => node.nodeId === 'publish');
  expect(lastJsonObject(publish?.output)).toMatchObject({ outcome: 'ok', target: 'folder' });
  expect(JSON.parse(readFileSync(join(ws, 'release', 'publish-record.json'), 'utf8')).target).toBe('folder');
  expect(readFileSync(join(ws, 'out', 'site', 'index.html'), 'utf8')).toBe('<h1>Bindery</h1>');
  expect(final.nodes.at(-1)?.nodeId).toBe('done');
  expect(lastJsonObject(final.nodes.at(-1)?.output)).toMatchObject({ verdict: 'published-local' });
  // 원 스킬 7단계가 경로에 있다: 미디어 감사 → 모션·모바일(⑥) → QA → 발행 승인
  const path = final.nodes.map(node => node.nodeId);
  expect(path.indexOf('audit_media')).toBeLessThan(path.indexOf('motion'));
  expect(path.indexOf('motion')).toBeLessThan(path.indexOf('qa'));
  expect(path.indexOf('qa')).toBeLessThan(path.indexOf('approve_release'));
}, 60_000);

test('publish refuses a linked site/ or links inside it', () => {
  const ws = temp();
  const real = temp();
  writeFileSync(join(real, 'index.html'), '<h1>x</h1>');
  symlinkSync(real, join(ws, 'site'));
  const linkedSite = step('publish', ws, released(ws));
  expect(linkedSite.outcome).toBe('fail');
  expect(String(linkedSite.error)).toContain('site/ 가 보통 폴더가 아니다');
  rmSync(join(ws, 'site'));
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  symlinkSync(join(real, 'index.html'), join(ws, 'site', 'other.html'));
  const inner = step('publish', ws, released(ws)); // 링크를 더한 «뒤»의 지문 — 지문 불일치가 아니라 링크 검사로 막혀야 한다
  expect(inner.outcome).toBe('fail');
  expect(String(inner.error)).toContain('site/ 안에 링크');
  expect(existsSync(join(ws, 'out', 'site'))).toBe(false);
});

test('verify_public stays unobserved for a stale or different-URL re-check record', () => {
  const ws = temp();
  mkdirSync(join(ws, 'release'));
  const url = 'https://site.webpub-check.dev/site/';
  const publish = { publish: { outcome: 'ok', target: 'pub', url } };
  writeFileSync(join(ws, 'release', 'verify-public.json'), JSON.stringify({ url, status: 200, qa_rerun: true, checked_at: '2026-01-01T00:00:00Z' }));
  writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url, at: '2026-10-09T00:00:00Z' }));
  expect(step('verify-public', ws, publish, false, 'pub').outcome).toBe('unobserved');
  const publishedAt = new Date(Date.now() - 3_600_000);
  utimesSync(join(ws, 'release', 'publish-record.json'), publishedAt, publishedAt);
  writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url, at: publishedAt.toISOString() }));
  utimesSync(join(ws, 'release', 'publish-record.json'), publishedAt, publishedAt);
  const check = (checked_at: string, recUrl = url) => {
    writeFileSync(join(ws, 'release', 'verify-public.json'), JSON.stringify({ url: recUrl, status: 200, qa_rerun: true, checked_at }));
    return step('verify-public', ws, publish, false, 'pub').outcome;
  };
  const later = new Date(publishedAt.getTime() + 60_000).toISOString();
  expect(check(later, 'https://other.webpub-check.dev/')).toBe('unobserved');            // 다른 URL
  expect(check(publishedAt.toISOString())).toBe('unobserved');               // 발행과 같은 시각
  expect(check(new Date(Date.now() + 600_000).toISOString())).toBe('unobserved'); // 미래 시각
  expect(check(later)).toBe('ok');                                           // 발행 뒤 ⊕ 지금 이전
});

/** 트리 전체(폴더 포함)의 이름 ⊕ 종류 ⊕ 내용 해시 ⊕ mtime — 생성·삭제·덮어쓰기·만지기 모두 잡는다. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = lstatSync(join(dir, entry.name));
    if (entry.isSymbolicLink()) return [[rel, `link ${readlinkSync(join(dir, entry.name))} ${stat.mtimeMs}`]]; // 링크는 따라가지 않고 그 자체를 기록
    if (entry.isDirectory()) return [[`${rel}/`, `dir ${stat.mtimeMs}`], ...Object.entries(snapshot(join(dir, entry.name), rel))];
    return [[rel, `file ${createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex')} ${stat.mtimeMs}`]];
  }));
}

// 보증 범위: 주어진 workspace 의 트리·바이트·mtime 불변만 — 외부 호출 0 은 run-step 이 네트워크 API 를 쓰지 않는 것(코드)으로 지킨다.
test('every step with --dry leaves a filled workspace byte-for-byte unchanged', () => {
  const ws = temp();
  for (const d of ['strategy', 'site', 'qa', 'release', 'ref', 'ledger', 'empty']) mkdirSync(join(ws, d));
  writeFileSync(join(ws, 'strategy', 'claims.json'), '[]');
  writeFileSync(join(ws, 'strategy', 'page-map.json'), '[]');
  writeFileSync(join(ws, 'DESIGN.md'), '# d');
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [{ id: 'a', kind: 'image', file: 'a.png', role: 'mood', rights: 'own' }] }));
  writeFileSync(join(ws, 'qa', 'qa-report.json'), '{}');
  writeFileSync(join(ws, 'release', 'publish-record.json'), '{"target":"folder"}');
  writeFileSync(join(ws, 'ref', 'seed.json'), '{}');
  writeFileSync(join(ws, 'ledger', 'media_spend.jsonl'), '');
  writeFileSync(join(ws, 'brief.json'), '{"old":true}');
  writeFileSync(join(ws, 'project-brief.md'), 'mine');
  const before = snapshot(ws);
  for (const name of ['absorb', 'strategy', 'hero-slice', 'media', 'audit-media', 'motion', 'qa', 'publish', 'verify-public', 'unobserved', 'done', 'failed']) {
    const out = step(name, ws, {}, true);
    expect(['ok', 'skip', 'plan_only', 'fail']).toContain(String(out.outcome));
    if (name !== 'failed') expect(out.outcome).not.toBe('fail');
    expect(snapshot(ws)).toEqual(before);
  }
  const brief = step('brief', ws, {}, true);
  expect(brief.outcome).toBe('ok');
  expect(brief.workspace).not.toBe(ws);
  expect(snapshot(ws)).toEqual(before);
  rmSync(String(brief.workspace), { recursive: true, force: true });
});

// 벤더 파일 = 고정 커밋의 원본 ⊕ 출처 한 줄. 출처 줄을 걷어낸 내용의 git blob sha 가 원 저장소 트리의 sha 와 같아야 한다.
test('vendored files equal the pinned upstream blobs once the added source line is removed', () => {
  const upstream: Record<string, string> = {
    'SKILL.md': '11c1ff6f1d562f959c3f2364757033148f6dd34d',
    'agents/openai.yaml': '5de68ee779b8270528cc5dc32e985808cb64f824',
    'assets/project-brief.md': '38f4d5638f31577622ea9d8843b8c0c15980411e',
    'examples/evas.md': '586378985d77f5927a0d519418e7fef80f4e25d2',
    'references/art-direction.md': 'd8abe6904acc8cbb28a4528d2bd129eb6acdbaa5',
    'references/business-content.md': 'c5f2236137c2478bd5361a4ee006c2c04e91643b',
    'references/media-production.md': '1224fa3c0485ea279ac337d002cb8bc82b8348d2',
    'references/scroll-and-mobile.md': '38187aced8313069e19bf6c21c97afb1ca384a81',
    'references/verification-and-release.md': '05ab7683a12602dcef0a41c0b297d788716bc959',
    'scripts/audit-media.mjs': '748c7ffb0e2e0259363389738d7a77a3fde3c40a',
  };
  const skill = join(GRAPHS, '..', 'skills', 'business-motion-websites');
  const blob = (text: string) => { const bytes = Buffer.from(text, 'utf8'); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
  for (const [name, sha] of Object.entries(upstream)) {
    const text = readFileSync(join(skill, name), 'utf8');
    // 출처 줄의 «자리»: 맨 앞 줄(SKILL.md 는 프런트매터 바로 뒤 · .mjs 는 #! 바로 뒤)
    const lines = text.split('\n');
    const at = name === 'SKILL.md' ? lines.indexOf('---', 1) + 2 : name.endsWith('.mjs') ? 1 : 0;
    expect(`${name}: ${lines[at]?.slice(0, 12)}`).toBe(`${name}: ${name.endsWith('.mjs') ? '// Source: p' : name.endsWith('.yaml') ? '# Source: pa' : '<!-- Source:'}`);
    expect(lines[at]).toContain('passeth/business-motion-websites @ fe5e8b0ae3a208efba751d3dd13aa168afd4fa74');
    const original = name === 'SKILL.md' ? [...lines.slice(0, at - 1), ...lines.slice(at + 1)].join('\n')
      : name.endsWith('.mjs') ? [lines[0], ...lines.slice(2)].join('\n')
      : name.endsWith('.yaml') ? lines.slice(1).join('\n')
      : lines.slice(2).join('\n');
    expect(`${name} ${blob(original)}`).toBe(`${name} ${sha}`);
  }
});

test('pub publish accepts only a record written after this run\'s release approval', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const old = new Date(Date.now() - 7_200_000);
  writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url: 'https://site.webpub-check.dev/x/', at: old.toISOString() }));
  utimesSync(join(ws, 'release', 'publish-record.json'), old, old);
  const approvedAt = new Date(Date.now() - 3_600_000).toISOString();
  const approved = released(ws, { outcome: 'approved', decidedAt: approvedAt });
  const stale = step('publish', ws, approved, false, 'pub');
  expect(stale.outcome).toBe('pending');
  expect(stale.would_run).toEqual(['pub', 'add', join(ws, 'site'), '--copy']);
  writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url: 'https://site.webpub-check.dev/x/', at: new Date().toISOString() }));
  expect(step('publish', ws, approved, false, 'pub')).toMatchObject({ outcome: 'ok', url: 'https://site.webpub-check.dev/x/' });
  expect(step('publish', ws, released(ws), false, 'pub').outcome).toBe('pending'); // 승인 시각 모름 = 인정 안 함
});

test('strategy refuses an unverified claim whose public flag is missing or not false', () => {
  const ws = temp();
  mkdirSync(join(ws, 'strategy'));
  writeFileSync(join(ws, 'strategy', 'page-map.json'), JSON.stringify([{ page: 'home', question: 'q', answer: 'a', evidence: 'e', related: ['contact'], next_action: 'n' }]));
  writeFileSync(join(ws, 'DESIGN.md'), '# d\n');
  const claims = (c: Record<string, unknown>) => { writeFileSync(join(ws, 'strategy', 'claims.json'), JSON.stringify([{ claim: 'x', grade: '미확인', ...c }])); return step('strategy', ws).outcome; };
  expect(claims({})).toBe('fail');
  expect(claims({ public: 'true' })).toBe('fail');
  expect(claims({ public: true })).toBe('fail');
  expect(claims({ public: false })).toBe('ok');
});

// 보증 범위: 승인·재개·기록 대조 «연결»만 — 실제 pub 실행·공개 URL 접근은 하지 않는다(기록은 시험이 대신 쓴다). 그래서 판정은 unobserved.
test('a real pub run waits for the human publish record and accepts it after graph approval ⊕ resume (no real pub call, no URL fetch)', async () => {
  const ws = temp();
  const root = temp();
  mkdirSync(join(ws, 'strategy'));
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'qa'));
  writeFileSync(join(ws, 'strategy', 'claims.json'), JSON.stringify([{ claim: 'Quotes by photo', grade: '제안', public: true }]));
  writeFileSync(join(ws, 'strategy', 'page-map.json'), JSON.stringify([{ page: 'home', question: 'q', answer: 'a', evidence: 'e', related: [], next_action: 'quote' }]));
  writeFileSync(join(ws, 'DESIGN.md'), '# Design\n');
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>Bindery</h1>');
  writeFileSync(join(ws, 'site', 'tokens.css'), '/* generated from DESIGN.md */\n');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [] }));
  mkdirSync(join(ws, 'motion'));
  writeFileSync(join(ws, 'motion', 'motion-plan.json'), JSON.stringify([{ element: 'hero', kind: '구간 진입 등장', reduced_motion: 'static, text visible', mobile: 'same order' }]));
  writeFileSync(join(ws, 'qa', 'qa-report.json'), JSON.stringify({ ruler: 'manual', widths: { 390: 'pass', 768: 'pass', 1280: 'pass' },
    reduced_motion_content_visible: true, evidence: { emulator: 'pass', webkit: 'unverified', real_device: 'unverified' } }));
  const graph = join(GRAPHS, 'web-publish.yaml');
  const input = { business: 'A fictional bindery', goal: 'quote requests', workspace: ws, publish_target: 'pub' };
  const first = await runGraph(graph, { runId: 'webpub-pub', input, deps: { root } });
  expect(first.pending?.nodeId).toBe('approve_plan');
  decideGraphApproval(first.graphId, first.runId, 'approved', 'tester', root);
  expect((await runGraph(graph, { resumeRunId: first.runId, deps: { root } })).pending?.nodeId).toBe('approve_release');
  decideGraphApproval(first.graphId, first.runId, 'approved', 'tester', root);
  const waiting = await runGraph(graph, { resumeRunId: first.runId, deps: { root } });
  expect(waiting.pending?.nodeId).toBe('wait_publish');
  const approval = waiting.nodes.find(node => node.nodeId === 'approve_release');
  expect(lastJsonObject(approval?.output)?.decidedAt).toEqual(expect.any(String));
  expect(lastJsonObject(waiting.nodes.at(-1)?.output)).toMatchObject({ outcome: 'pending', would_run: ['pub', 'add', join(ws, 'site'), '--copy'] });
  // 사람이 안내된 명령을 실행했다고 치고 이번 발행 기록을 남긴다(외부 호출 없음).
  // 기록 시각을 승인 시각 + 1초로 «결정적으로» 둔다(파일시스템 mtime 해상도에 기대지 않는다).
  const releaseAt = Date.parse(String(lastJsonObject(approval?.output)?.decidedAt));
  await Bun.sleep(20);
  const recordAt = new Date(releaseAt + 10); // 승인 뒤 ⊕ 지금 이전(과거) — 미래 기록 거부는 별도 시험
  writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url: 'https://site.webpub-check.dev/bindery/', at: recordAt.toISOString() }));
  utimesSync(join(ws, 'release', 'publish-record.json'), recordAt, recordAt);
  decideGraphApproval(first.graphId, first.runId, 'approved', 'tester', root);
  const final = await runGraph(graph, { resumeRunId: first.runId, deps: { root } });
  expect(final.status).toBe('done');
  const publishes = final.nodes.filter(node => node.nodeId === 'publish').map(node => lastJsonObject(node.output)?.outcome);
  expect(publishes).toEqual(['pending', 'ok']);
  expect(lastJsonObject(final.nodes.find(node => node.nodeId === 'verify_public')?.output)?.outcome).toBe('unobserved');
  expect(lastJsonObject(final.nodes.at(-1)?.output)).toMatchObject({ verdict: 'unobserved' });
}, 60_000);

test('qa refuses a table that claims the webclone ruler when no webclone ruler is available', () => {
  const ws = temp();
  mkdirSync(join(ws, 'qa'));
  writeFileSync(join(ws, 'qa', 'qa-report.json'), JSON.stringify({ ruler: 'webclone', widths: { 390: 'pass', 768: 'pass', 1280: 'pass' },
    reduced_motion_content_visible: true, evidence: { emulator: 'pass', webkit: 'unverified', real_device: 'unverified' } }));
  expect(step('qa', ws).outcome).toBe('fail');
});

test('media waits for site media files that are not in the manifest, and strategy needs evidence and related pages', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site', 'media'), { recursive: true });
  writeFileSync(join(ws, 'site', 'media', 'photo.jpg'), 'x');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [] }));
  expect(step('media', ws).outcome).toBe('pending');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [{ id: 'p', kind: 'image', file: 'site/media/photo.jpg', role: '실제 사용 근거', rights: 'own photo' }] }));
  expect(step('media', ws).outcome).toBe('ok');
  mkdirSync(join(ws, 'strategy'));
  writeFileSync(join(ws, 'strategy', 'claims.json'), JSON.stringify([{ claim: 'x', grade: '제안', public: true }]));
  writeFileSync(join(ws, 'DESIGN.md'), '# d\n');
  writeFileSync(join(ws, 'strategy', 'page-map.json'), JSON.stringify([{ page: 'home', question: 'q', answer: 'a', next_action: 'n' }]));
  expect(step('strategy', ws).outcome).toBe('fail');
});

test('workspace writes refuse to follow a link', () => {
  const ws = temp();
  const outside = temp();
  writeFileSync(join(outside, 'victim.json'), 'keep');
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  symlinkSync(join(outside, 'victim.json'), join(ws, 'release', 'publish-record.json'));
  expect(step('publish', ws, released(ws)).outcome).toBe('fail');
  expect(readFileSync(join(outside, 'victim.json'), 'utf8')).toBe('keep');
});

test('a folder publish refuses to write its record through a linked release/ folder', () => {
  const ws = temp();
  const outside = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  symlinkSync(outside, join(ws, 'release'));
  expect(step('publish', ws, released(ws)).outcome).toBe('fail');
  expect(readdirSync(outside)).toEqual([]);
});

test('a pub record needs a valid `at` after the approval, not only a fresh file time', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const approved = released(ws, { outcome: 'approved', decidedAt: new Date(Date.now() - 60_000).toISOString() });
  const record = (r: Record<string, unknown>) => { writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url: 'https://site.webpub-check.dev/', ...r })); return step('publish', ws, approved, false, 'pub').outcome; };
  expect(record({})).toBe('pending');
  expect(record({ at: 'not a date' })).toBe('pending');
  expect(record({ at: new Date(Date.now() - 120_000).toISOString() })).toBe('pending');
  expect(record({ at: new Date().toISOString() })).toBe('ok');
});

test('publish refuses when site/ changed after the QA fingerprint', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const approved = released(ws);
  writeFileSync(join(ws, 'site', 'late.html'), 'changed after QA');
  const late = step('publish', ws, approved);
  expect(late.outcome).toBe('fail');
  expect(String(late.error)).toContain('QA');
  expect(existsSync(join(ws, 'out', 'site'))).toBe(false);
  expect(step('publish', ws, { approve_release: { outcome: 'approved' } }).outcome).toBe('fail'); // QA 지문 없음
  expect(step('publish', ws, released(ws)).outcome).toBe('ok');
});

test('dry-run cleanup deletes only the temp folder its own brief marked', () => {
  const foreign = mkdtempSync(join(tmpdir(), 'web-publish-dry-'));
  dirs.push(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'user file');
  const ws = temp();
  expect(step('done', ws, { brief: { workspace: foreign, dry_owner: 'guess' } }, true).outcome).toBe('ok');
  expect(existsSync(join(foreign, 'keep.txt'))).toBe(true);
  const brief = step('brief', ws, {}, true);
  const own = String(brief.workspace);
  expect(existsSync(own)).toBe(true);
  expect(step('done', ws, { brief }, true).outcome).toBe('ok');
  expect(existsSync(own)).toBe(false);
});

test('publish and verify accept only public https URLs', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const approved = released(ws, { outcome: 'approved', decidedAt: new Date(Date.now() - 60_000).toISOString() });
  for (const url of ['file:///tmp/site', 'not-a-url', 'http://example.test/', '']) {
    writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url, at: new Date().toISOString() }));
    expect(`${url} ${step('publish', ws, approved, false, 'pub').outcome}`).toBe(`${url} pending`);
    writeFileSync(join(ws, 'release', 'verify-public.json'), JSON.stringify({ url, status: 200, qa_rerun: true, checked_at: new Date().toISOString() }));
    expect(`${url} ${step('verify-public', ws, { publish: { outcome: 'ok', url } }, false, 'pub').outcome}`).toBe(`${url} unobserved`);
  }
});

test('media added after the media audit (e.g. during wait_qa) blocks publishing, listed or not', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [] }));
  const audited = mediaDigest(ws);
  writeFileSync(join(ws, 'site', 'late.jpg'), 'late');
  const ctx = (extra = {}) => ({ approve_release: { outcome: 'approved' }, audit_media: { media_digest: audited }, qa: { site_digest: siteDigest(join(ws, 'site')) }, ...extra });
  const unlisted = step('publish', ws, ctx());
  expect(unlisted.outcome).toBe('fail');
  expect(String(unlisted.error)).toContain('목록에 없는 미디어');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [{ id: 'l', kind: 'image', file: 'site/late.jpg', role: 'mood', rights: 'own' }] }));
  const changed = step('publish', ws, ctx());
  expect(changed.outcome).toBe('fail');
  expect(String(changed.error)).toContain('감사');
  expect(existsSync(join(ws, 'out', 'site'))).toBe(false);
});

test('isPublicHttpsUrl refuses local and private hosts', () => {
  for (const url of ['https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.1.2/', 'https://172.20.0.1/', 'https://8.8.8.8/', 'https://[::1]/',
    'https://[::ffff:7f00:1]/', 'https://[fe90::1]/', 'https://[2001:db8::1]/', 'https://box.local/', 'https://svc.internal/',
    'https://example.com/', 'https://www.example.org/', 'https://site.test/', 'https://a.example/', 'https://x.invalid/',
    'https://localhost./', 'https://example.com./', 'https://box.local./', 'https://printer/', 'https://intranet./'])
    expect(`${url} ${isPublicHttpsUrl(url)}`).toBe(`${url} false`);
  for (const url of ['https://site.webpub-check.dev/a/', 'https://pub.bindery-studio.co.kr/'])
    expect(`${url} ${isPublicHttpsUrl(url)}`).toBe(`${url} true`);
});

test('event log and reference hashing do not follow links out of the workspace', () => {
  const ws = temp();
  const outside = temp();
  symlinkSync(outside, join(ws, '.web-publish'));
  const brief = step('brief', ws);
  expect(brief.outcome).toBe('ok');
  expect(readdirSync(outside)).toEqual([]);
  mkdirSync(join(ws, 'ref'), { recursive: true });
  writeFileSync(join(ws, 'ref', 'seed.json'), '{}');
  writeFileSync(join(outside, 'x.png'), 'x');
  symlinkSync(outside, join(ws, 'ref', 'assets'));
  const absorb = step('absorb', ws);
  expect(absorb.outcome).toBe('fail');
  expect(String(absorb.error)).toContain('ref/assets');
});

test('ref/assets with a file link is refused rather than skipped', () => {
  const ws = temp();
  const outside = temp();
  writeFileSync(join(outside, 'orig.jpg'), 'original photo');
  mkdirSync(join(ws, 'ref', 'assets'), { recursive: true });
  writeFileSync(join(ws, 'ref', 'seed.json'), '{}');
  symlinkSync(join(outside, 'orig.jpg'), join(ws, 'ref', 'assets', 'orig.jpg'));
  const absorb = step('absorb', ws);
  expect(absorb.outcome).toBe('fail');
  expect(String(absorb.error)).toContain('링크');
});

test('graph --dry-run with real context passing reaches done and leaves the given workspace unchanged', async () => {
  const ws = temp();
  const root = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>keep</h1>');
  const before = snapshot(ws);
  const run = await runGraph(join(GRAPHS, 'web-publish.yaml'), { runId: 'webpub-dry', dryRun: true, deps: { root },
    input: { business: 'b', goal: 'g', workspace: ws, publish_target: 'folder', reference_urls: ['https://example.com/'] } });
  expect(run.status).toBe('done');
  expect(lastJsonObject(run.nodes.at(-1)?.output)).toMatchObject({ verdict: 'dry-run' });
  expect(snapshot(ws)).toEqual(before);
  const dryWs = String(lastJsonObject(run.nodes[0]?.output)?.workspace);
  expect(dryWs).not.toBe(ws);
  expect(existsSync(dryWs)).toBe(false); // done --dry 가 자기 임시 폴더를 걷었다
}, 60_000);

test('vercel needs an approval record written after this run\'s release approval', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const decidedAt = new Date(Date.now() - 60_000).toISOString();
  const approved = released(ws, { outcome: 'approved', decidedAt });
  writeFileSync(join(ws, 'release', 'vercel-approval.json'), JSON.stringify({ approved_by: 'owner', approved_at: new Date(Date.now() - 120_000).toISOString() }));
  expect(step('publish', ws, approved, false, 'vercel').outcome).toBe('fail');
  writeFileSync(join(ws, 'release', 'vercel-approval.json'), JSON.stringify({ approved_by: 'owner', approved_at: new Date().toISOString() }));
  const ok = step('publish', ws, approved, false, 'vercel');
  expect(ok.outcome).toBe('pending');
  expect(ok.would_run).toEqual(['vercel', 'deploy', join(ws, 'site'), '--prod']);
});

test('a folder publish verifies the copy against the QA fingerprint', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const ctx = released(ws);
  expect(step('publish', ws, ctx).outcome).toBe('ok');
  expect(step('verify-public', ws, ctx).outcome).toBe('ok');
  writeFileSync(join(ws, 'out', 'site', 'index.html'), '<h1>tampered</h1>');
  expect(step('verify-public', ws, ctx).outcome).toBe('fail');
});

test('audit_media refuses broken links and playlist-like files before ffprobe can reach the network', async () => {
  const ws = temp();
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response('x'); } });
  try {
    symlinkSync(join(temp(), 'gone.png'), join(ws, 'broken.png'));
    const manifest = (assets: unknown[]) => writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets }));
    manifest([{ id: 'b', kind: 'image', file: 'broken.png', role: 'mood', rights: 'own' }]);
    const broken = step('audit-media', ws);
    expect(broken.outcome).toBe('fail');
    expect(String(broken.error)).toContain('workdir 밖');
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${server.port}/seg.ts\n#EXT-X-ENDLIST\n`;
    writeFileSync(join(ws, 'clip.mp4'), playlist);          // 확장자는 영상이지만 내용은 재생목록
    writeFileSync(join(ws, 'poster.png'), 'x');
    manifest([{ id: 'v', kind: 'video', file: 'clip.mp4', poster: 'poster.png', role: 'mood', rights: 'own' }]);
    const disguised = step('audit-media', ws);
    expect(disguised.outcome).toBe('fail');
    expect(String(disguised.error)).toContain('재생목록');
    writeFileSync(join(ws, 'clip.m3u8'), playlist);
    manifest([{ id: 'v', kind: 'video', file: 'clip.m3u8', poster: 'poster.png', role: 'mood', rights: 'own' }]);
    expect(['fail', 'fix']).toContain(String(step('audit-media', ws).outcome)); // 영상 확장자가 아니라 검사기 전에 돌려보낸다
    await Bun.sleep(50);
    expect(requests).toBe(0);
  } finally { server.stop(true); }
});

test('vercel approval written with a future time or before this release approval is refused', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const decidedAt = new Date(Date.now() - 60_000);
  const approved = released(ws, { outcome: 'approved', decidedAt: decidedAt.toISOString() });
  const file = join(ws, 'release', 'vercel-approval.json');
  writeFileSync(file, JSON.stringify({ approved_by: 'owner', approved_at: new Date(Date.now() + 3_600_000).toISOString() }));
  expect(step('publish', ws, approved, false, 'vercel').outcome).toBe('fail');            // 미래 시각
  writeFileSync(file, JSON.stringify({ approved_by: 'owner', approved_at: new Date(Date.now() - 30_000).toISOString() }));
  const before = new Date(decidedAt.getTime() - 60_000);
  utimesSync(file, before, before);
  expect(step('publish', ws, approved, false, 'vercel').outcome).toBe('fail');            // 파일이 승인 전에 쓰였다
});

test('site fingerprint is not fooled by moving bytes across a file boundary', () => {
  const a = temp();
  const b = temp();
  writeFileSync(join(a, 'a'), 'x\0b.js\0y');
  writeFileSync(join(b, 'a'), 'x');
  writeFileSync(join(b, 'b.js'), 'y');
  expect(siteDigest(a)).not.toBe(siteDigest(b));
});

test('a pub record dated in the future is not accepted', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  mkdirSync(join(ws, 'release'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const approved = released(ws, { outcome: 'approved', decidedAt: new Date(Date.now() - 60_000).toISOString() });
  const future = new Date(Date.now() + 3_600_000);
  writeFileSync(join(ws, 'release', 'publish-record.json'), JSON.stringify({ target: 'pub', url: 'https://site.webpub-check.dev/', at: future.toISOString() }));
  utimesSync(join(ws, 'release', 'publish-record.json'), future, future);
  expect(step('publish', ws, approved, false, 'pub').outcome).toBe('pending');
});

test('audio and SVG assets are listed but not probed; motion plan needs the five kinds with reduced-motion and mobile notes', () => {
  const ws = temp();
  writeFileSync(join(ws, 'voice.mp3'), 'ID3');
  writeFileSync(join(ws, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [
    { id: 'v', kind: 'audio', file: 'voice.mp3', role: '절차 설명', rights: 'own' },
    { id: 'l', kind: 'image', file: 'logo.svg', role: 'mood', rights: 'own' },
  ] }));
  expect(step('audit-media', ws)).toMatchObject({ outcome: 'skip', not_probed: ['v', 'l'] });
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [{ id: 'v', kind: 'video', file: 'voice.mp3', role: 'mood', rights: 'own' }] }));
  expect(step('audit-media', ws).outcome).toBe('fix'); // kind=video 인데 음성 파일
  expect(step('motion', ws).outcome).toBe('pending');
  mkdirSync(join(ws, 'motion'));
  writeFileSync(join(ws, 'motion', 'motion-plan.json'), JSON.stringify([{ element: 'hero', kind: 'parallax' }]));
  expect(step('motion', ws).outcome).toBe('fail');
  writeFileSync(join(ws, 'motion', 'motion-plan.json'), JSON.stringify([{ element: 'hero video', kind: '분위기 영상 루프', reduced_motion: 'poster image', mobile: 'muted inline' }]));
  expect(step('motion', ws)).toMatchObject({ outcome: 'ok', kinds: ['loop'] });
});

test('done reports verified only after verify_public said ok', () => {
  const ws = temp();
  const target = (t: string, outputs: Record<string, unknown>) => step('done', ws, outputs, false, t).verdict;
  expect(target('pub', {})).toBe('incomplete');
  expect(target('pub', { verify_public: { outcome: 'unobserved' } })).toBe('incomplete');
  expect(target('pub', { unobserved: { verdict: 'unobserved' } })).toBe('unobserved');
  expect(target('pub', { verify_public: { outcome: 'ok' } })).toBe('verified');
  expect(target('folder', {})).toBe('incomplete');
  expect(target('folder', { verify_public: { outcome: 'ok' } })).toBe('published-local');
});

test('folder verify refuses an out/ link swapped in after publishing', () => {
  const ws = temp();
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'index.html'), '<h1>x</h1>');
  const ctx = released(ws);
  expect(step('publish', ws, ctx).outcome).toBe('ok');
  rmSync(join(ws, 'out'), { recursive: true });
  symlinkSync(ws, join(ws, 'out'));   // out/site → 원본 site/ (지문은 같다)
  expect(step('verify-public', ws, ctx).outcome).toBe('fail');
});

test('assets that are not probed must still exist as real files in the workspace', () => {
  const ws = temp();
  writeFileSync(join(ws, 'media-manifest.json'), JSON.stringify({ assets: [{ id: 'a', kind: 'audio', file: 'site/missing.mp3', role: 'mood', rights: 'own' }] }));
  expect(step('audit-media', ws).outcome).toBe('fix');
  mkdirSync(join(ws, 'site'));
  writeFileSync(join(ws, 'site', 'missing.mp3'), 'ID3');
  expect(step('audit-media', ws).outcome).toBe('skip');
});
