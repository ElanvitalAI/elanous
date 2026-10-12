/**
 * `elanous memory` 명령 묶음 등록 — BIG-FILE-index-1 첫 조각(순수 이동 · src/index.ts → src/cli/memory-cli.ts).
 * 로직·문면·옵션·종료 코드는 이동 원본과 동일하다.
 */
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { readPipedStdin } from './piped-stdin.js';
import {
  saveMemory, loadMemory, listMemories, deleteMemory, searchMemories,
  readIndex, memoryRoot, memoryIndexPath,
  type MemoryType,
} from '../memory.js';

export function registerMemoryCommands(program: Command): void {
  const memCmd = program.command('memory').description('Persistent memories injected into every chat turn (user / feedback / project / reference)');

  memCmd
  .command('list [type]')
  .description('List memories (optionally filtered by type)')
  .option('-n, --limit <n>', 'Max entries to show', '30')
  .action((type?: string, opts?: { limit: string }) => {
    const t = type as MemoryType | undefined;
    const entries = listMemories({ type: t, limit: parseInt(opts?.limit ?? '30', 10) });
    if (entries.length === 0) {
      ui.info('No memories yet. Add one with `elanous memory add <type> "<name>" "<description>"`.');
      return;
    }
    ui.header(`memories (${entries.length})`);
    for (const e of entries) {
      console.log(`  ${e.id.slice(0, 8)}  [${e.type.padEnd(9)}]  ${e.name}`);
      if (e.description) console.log(`             ${e.description.slice(0, 100)}`);
    }
  });

  memCmd
  .command('add <type> <name> [description...]')
  .description('Create a memory (type: user|feedback|project|reference). Body piped via stdin if available.')
  .action(async (type: string, name: string, descParts: string[]) => {
    if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
      ui.error(`invalid type "${type}". Use: user | feedback | project | reference`);
      process.exit(1);
    }
    const description = (descParts || []).join(' ');
    // Read body from stdin if piped; otherwise use description as body too.
    let body = description;
    const pipedBody = await readPipedStdin();   // ★ OBS-T3 — 비-TTY 는 파이프를 뜻하지 않는다(소켓이면 EOF 가 안 온다)
    if (pipedBody) body = pipedBody;
    const e = saveMemory({ type: type as MemoryType, name, description, body });
    ui.info(`saved ${e.id.slice(0, 8)} [${e.type}] "${e.name}"`);
  });

  // 3번째 recall 레버(2026-07-19) — pin(항상주입) / priority(매칭 시 순위 부스트).
  memCmd
  .command('pin <idPrefix>')
  .description('Pin a memory so it is ALWAYS injected (bypass keyword gate). Optionally set priority.')
  .option('-p, --priority <n>', 'priority boost (higher = ranked/kept first)', '5')
  .action((prefix: string, opts: { priority: string }) => {
    const e = loadMemory(prefix);
    if (!e) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    saveMemory({ type: e.type, name: e.name, description: e.description, body: e.body, id: e.id, pinned: true, priority: parseInt(opts.priority, 10) || 0 });
    ui.info(`📌 pinned ${e.id.slice(0, 8)} "${e.name}" (priority ${opts.priority})`);
  });

  memCmd
  .command('unpin <idPrefix>')
  .description('Un-pin a memory (back to keyword-gated recall).')
  .action((prefix: string) => {
    const e = loadMemory(prefix);
    if (!e) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    saveMemory({ type: e.type, name: e.name, description: e.description, body: e.body, id: e.id, pinned: false, priority: e.priority });
    ui.info(`unpinned ${e.id.slice(0, 8)} "${e.name}"`);
  });

  memCmd
  .command('priority <idPrefix> <n>')
  .description('Set a memory\'s injection priority boost (0 = default). Added to match score.')
  .action((prefix: string, n: string) => {
    const e = loadMemory(prefix);
    if (!e) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    saveMemory({ type: e.type, name: e.name, description: e.description, body: e.body, id: e.id, priority: parseInt(n, 10) || 0, pinned: e.pinned });
    ui.info(`priority ${e.id.slice(0, 8)} "${e.name}" → ${parseInt(n, 10) || 0}`);
  });

  // 통합 관리 뷰(2026-07-19) — 2 시스템(큐레이션 파일메모리 + 에피소드 self-log)을 한 화면에.
  memCmd
  .command('status')
  .description('Unified memory overview — ① curated file-memory + ② self-log (surface_events)')
  .action(async () => {
    const { memoryRoot } = await import('../memory.js');
    const mems = listMemories();
    const byType: Record<string, number> = {};
    let pinned = 0;
    for (const e of mems) { byType[e.type] = (byType[e.type] ?? 0) + 1; if (e.pinned) pinned += 1; }
    ui.header('memory (unified)');
    console.log(`① 큐레이션 파일메모리: ${mems.length}건  [${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}]  📌pinned ${pinned}`);
    console.log(`   ${memoryRoot()}  (LLM-judge/luna recall · MEMORY.md 항상주입)`);
    try {
      const { surfaceEventsDbPath, openSurfaceEventsDb } = await import('../domains/surface-events.js');
      const path = surfaceEventsDbPath();
      // 항상 open — legacy conatus/ → memory/ 자가치유 마이그레이션이 여기서 실행된다(존재 체크 먼저
      // 하면 신 경로 부재로 마이그레이션이 스킵됨). 없으면 빈 store 생성(무해).
      const db = openSurfaceEventsDb(path);
      const n = (db.prepare('SELECT count(*) c FROM events').get() as { c: number }).c;
      const recent = (db.prepare('SELECT ts FROM events ORDER BY ts DESC LIMIT 1').get() as { ts: string } | undefined)?.ts;
      db.close();
      console.log(`② 에피소드 self-log: ${n.toLocaleString()} events  (최근 ${recent?.slice(0, 16) ?? '-'})`);
      console.log(`   ${path}  (FTS5 bm25+recency+myelin rerank · ambient 회상)`);
    } catch (e) { console.log(`② self-log 조회 실패: ${(e as Error).message}`); }
    try {
      const { openKnowledgeDb, knowledgeDbPath } = await import('../domains/knowledge.js');
      const kdb = openKnowledgeDb(); // 기본 경로 → legacy conatus/ 자가치유 이전
      const kn = (kdb.prepare('SELECT count(*) c FROM docs').get() as { c: number }).c;
      const dom = (kdb.prepare("SELECT domain, count(*) c FROM docs GROUP BY domain ORDER BY c DESC LIMIT 3").all() as Array<{ domain: string | null; c: number }>);
      kdb.close();
      console.log(`③ 시맨틱 knowledge: ${kn.toLocaleString()} docs  [${dom.map(d => `${d.domain ?? 'null'}:${d.c}`).join(' ')}]`);
      console.log(`   ${knowledgeDbPath()}  (임베딩 벡터+BM25 하이브리드 · 의미 회상)`);
    } catch (e) { console.log(`③ knowledge 조회 실패: ${(e as Error).message}`); }
  });

  memCmd
  .command('show <idPrefix>')
  .description('Print full memory body')
  .action((prefix: string) => {
    const entries = listMemories();
    const hit = entries.find(e => e.id.startsWith(prefix));
    if (!hit) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    const full = loadMemory(hit.id)!;
    ui.header(`${full.type}: ${full.name}`);
    console.log(`  id          ${full.id}`);
    console.log(`  created     ${full.createdAt}`);
    console.log(`  updated     ${full.updatedAt}`);
    console.log(`  description ${full.description}`);
    console.log('');
    console.log(full.body);
  });

  memCmd
  .command('search <query...>')
  .description('Keyword search across all memories')
  .option('--type <t>', 'Filter by type')
  .option('-n, --limit <n>', 'Max results', '10')
  .action((parts: string[], opts) => {
    const hits = searchMemories(parts.join(' '), {
      type: opts.type as MemoryType | undefined,
      limit: parseInt(opts.limit, 10),
    });
    if (hits.length === 0) { ui.info('No matches.'); return; }
    ui.header(`matches (${hits.length})`);
    for (const h of hits) {
      console.log(`  ${h.entry.id.slice(0, 8)}  score ${h.score}  [${h.entry.type}]  ${h.entry.name}`);
      if (h.entry.description) console.log(`             ${h.entry.description.slice(0, 100)}`);
    }
  });

  memCmd
  .command('delete <idPrefix>')
  .description('Delete a memory')
  .action((prefix: string) => {
    const entries = listMemories();
    const hit = entries.find(e => e.id.startsWith(prefix));
    if (!hit) { ui.error(`no memory matching "${prefix}"`); process.exit(1); }
    deleteMemory(hit.id);
    ui.info(`deleted ${hit.id.slice(0, 8)}`);
  });

  memCmd
  .command('index')
  .description('Print MEMORY.md index verbatim')
  .action(() => {
    const idx = readIndex();
    if (!idx) { ui.info('empty (no memories yet)'); return; }
    console.log(idx);
  });

  memCmd
  .command('where')
  .description('Show the memory storage path')
  .action(() => {
    console.log(`memory dir   ${memoryRoot()}`);
    console.log(`index file   ${memoryIndexPath()}`);
  });
}