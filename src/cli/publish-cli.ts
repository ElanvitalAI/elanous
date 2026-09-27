import type { Command } from 'commander';
import { writeStdoutJson } from './stdout-json.js';

export function registerPublishCommands(program: Command): void {
// ── publish (external-markdown 게시 라이프사이클 GC) ──
const publishCmd = program.command('publish').description('external-markdown 게시 라이프사이클 — 만료 게시물 GC(S3 콜드 백업·삭제 아님)');
publishCmd
  .command('gc')
  .description('만료 게시물 GC — 1년 만료분을 S3 콜드(Glacier) 백업(삭제 아님)·permanent 자동보존. elanous schedule 크론용.')
  .option('--root <dir>', '게시 저장 루트(기본 ~/.elanous/publishing·ELANOUS_PUBLISH_ROOT)')
  .option('--json', '구조화 출력 {archived, kept, errors}')
  .action(async (opts: { root?: string; json?: boolean }) => {
    const { runPublishGc } = await import('../nexus/api/markdown-publish.js');
    const r = await runPublishGc(opts.root ? { root: opts.root } : {});
    if (opts.json) await writeStdoutJson(JSON.stringify(r) + '\n');
    else console.log(`[publish gc] 콜드백업 ${r.archived.length}건 · 보존 ${r.kept}건 · 실패 ${r.errors.length}건${r.errors.length ? ' — ' + r.errors.map((e) => e.id).join(',') : ''}`);
    process.exit(r.errors.length ? 1 : 0);
  });
publishCmd
  .command('catalog')
  .description('공개 콘텐츠 카탈로그(피드 보드 데이터) 빌드 — 전 게시물을 newest-first 공개 레코드로 프로젝션(만료·타깃없음 제외).')
  .option('--root <dir>', '게시 저장 루트(기본 ~/.elanous/publishing·ELANOUS_PUBLISH_ROOT)')
  .option('--json', '구조화 출력 — CatalogRecord[] JSON (피드/파이프라인용)')
  .action(async (opts: { root?: string; json?: boolean }) => {
    const { buildPublishCatalog } = await import('../nexus/api/markdown-publish.js');
    const records = await buildPublishCatalog(opts.root ? { root: opts.root } : {});
    if (opts.json) await writeStdoutJson(JSON.stringify(records) + '\n');
    else console.log(`[publish catalog] ${records.length}건 · domain: ${[...new Set(records.map((r) => r.domain ?? 'other'))].join(', ')}`);
    process.exit(0);
  });
publishCmd
  .command('file <path>')
  .description('마크다운 파일(Obsidian 등)을 외부 공개 게시하고 공개 URL 반환 — 공백·한글 경로 안전. skill/자동화용.')
  .option('--json', '구조화 출력 {ok, url, path}')
  .action(async (path: string, opts: { json?: boolean }) => {
    const { publishObsidianFile } = await import('../skills/url-route-exec.js');
    const url = publishObsidianFile(path);
    if (opts.json) await writeStdoutJson(JSON.stringify({ ok: !!url, url, path }) + '\n');
    else if (url) console.log(url);
    else console.error('게시 실패 — 파일 없음·빈 파일·S3 미가용·게시 오류(elanous logs --category url-route.publish 확인)');
    process.exit(url ? 0 : 1);
  });

}
