/**
 * `elanous memory` 명령 묶음 등록 — BIG-FILE-index-1 첫 조각(순수 이동 · src/index.ts → src/cli/memory-cli.ts).
 * 로직·문면·옵션·종료 코드는 이동 원본과 동일하다.
 */
import type { Command } from 'commander';
import * as ui from '../ui.js';
import { readPipedStdin } from './piped-stdin.js';
import { recordMemoryUsage } from '../memory-triage/usage-ledger.js';
import {
  saveMemory, loadMemory, listMemories, deleteMemory, searchMemories,
  readIndex, memoryRoot, memoryIndexPath,
  type MemoryType,
} from '../memory.js';
import { applyClaudeMemoryImport, claudeMemoryRoot, collectClaudeMemoryFiles } from '../context-bus/claude-memory-import.js';
import { importClaudeMemories } from '../context-bus/long-term-memory.js';
import { buildSeatMemoryIndexBlock, normalizeSeat, rebuildSeatMemoryIndex, seatMemoryDir } from '../seat-memory/seat-memory.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applySeatMemoryImport, planSeatMemoryImport, summarizeSeatMemoryImport, type SeatMemoryImportPlan } from '../seat-memory/seat-memory-import.js';
import { OP_SEED_ALLOWED_SOURCE_ROOTS, OP_SEED_DECISIONS_RECENT_DEFAULT, applyOpMemorySeed, planOpMemorySeed, summarizeOpMemorySeed, type OpMemorySeedPlan } from '../seat-memory/op-memory-seed.js';

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
    const e = saveMemory({ type: type as MemoryType, name, description, body }, undefined, { origin: 'memory-cli.add' });
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
    // MEMORY-TRIAGE-NO-LLM ③ 생산자 — 사람이 찾아 꺼낸 기억도 «쓰임»이다(id 해시만 · 빈 결과도 시도로 남는다).
    recordMemoryUsage({ store: 'global', via: 'search', usedIds: hits.map(h => h.entry.id) }, memoryRoot());
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

  // 🧠 OP-MEMORY-PARITY (O6 · 대표 11-17) — Claude Code 기억 폴더 하나 → eln 자리 기억 저장소(`<memoryRoot>/seats/<SEAT>`).
  //    원본 읽기 전용 · 기본 미리보기(쓰기 0) · `--apply` 일 때만 쓴다 · 비밀처럼 보이는 파일은 거부하고 이름만 출력한다.
  memCmd
  .command('import')
  .description('Import one Claude Code memory dir into an eln seat memory store (dry-run unless --apply; source is read-only)')
  .requiredOption('--from <dir>', 'Claude Code memory dir (…/.claude/projects/<project>/memory)')
  .requiredOption('--seat <SEAT>', 'target seat id (e.g. OP)')
  .option('--to <dir>', 'override target dir (default <memoryRoot>/seats/<SEAT>)')
  .option('--apply', 'write the files (default: dry-run preview)')
  .action((opts: { from: string; seat: string; to?: string; apply?: boolean }) => {
    const seat = normalizeSeat(opts.seat);
    if (!seat) { ui.error(`invalid seat "${opts.seat}"`); process.exit(1); }
    let plan: SeatMemoryImportPlan;
    try { plan = planSeatMemoryImport({ from: opts.from, to: opts.to ?? seatMemoryDir(seat), seat }); }
    catch (error) { ui.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
    const summary = opts.apply ? applySeatMemoryImport(plan) : summarizeSeatMemoryImport(plan, false);
    ui.header(`seat memory import ${opts.apply ? '(applied)' : '(dry-run — nothing written)'} → ${plan.to}`);
    console.log(`  create ${summary.create} · update ${summary.update} · same ${summary.same} · skipped ${summary.skipped} · index lines dropped ${plan.indexDroppedLines}`);
    if (plan.supplementalIndex) console.log(`  unindexed reference ${plan.supplementalIndex.file}`);
    for (const [reason, count] of Object.entries(summary.skippedByReason)) console.log(`  skipped ${reason}: ${count}`);
    // 비밀처럼 보인 파일은 이름만(본문·일치 값 0).
    for (const name of summary.refusedNames) console.log(`  refused (secret-pattern): ${name}`);
    if (!opts.apply) console.log('  re-run with --apply to write');
  });

  // ELN-OP-MEMORY-SEED (TC-H-CC-1 · OP #128162 · 11-22) — 진단 DIAG-ELN-OP-COORDINATOR-1122 §2·지렛대 4.
  // Claude OP 기억(⭐ 색인) ⊕ OPS-RULES 핵심 ⊕ DECISIONS 최근 행 ⊕ LANDING 노하우 머리를
  // OP 자리 기억 저장소에 한 번에 시딩한다. 원본 읽기 전용 · 기본 미리보기 · --apply 일 때만 쓴다.
  memCmd
  .command('seed-op')
  .description('Seed the OP seat memory store from Claude OP memories + OPS-RULES + recent DECISIONS + LANDING knowhow (dry-run unless --apply; sources read-only)')
  .option('--claude-dir <dir>', 'Claude Code OP memory dir (read-only source)', join(homedir(), '.claude', 'projects', '-Users-user-elanous-hq-repo-git', 'memory'))
  .option('--ops-rules <path>', 'OPS-RULES.md path (read-only source)', join(homedir(), 'elanous-hq', 'seat-state', 'OPS', 'OPS-RULES.md'))
  .option('--decisions <path>', 'DECISIONS-OP.tsv path (read-only source)', join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'DECISIONS-OP.tsv'))
  .option('--landing <path>', 'LANDING-KNOWHOW.md path (read-only source)', join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'LANDING-KNOWHOW.md'))
  // JUD 보안(jud-39558-649412ff0298 · OP #130135/#130136 «목적지 OP 고정») — --seat/--to 선택지 폐지.
  // OP 원본을 타 자리 저장소로 옮기는 길을 CLI 표면에서 완전히 닫는다(목적지 = <memoryRoot>/seats/OP 고정).
  .option('--decisions-recent <n>', 'recent DECISIONS rows to keep', '25')
  .option('--apply', 'write the files (default: dry-run preview)')
  .action((opts: { claudeDir: string; opsRules: string; decisions: string; landing: string; decisionsRecent: string; apply?: boolean }) => {
    // 목적지 OP 고정(JUD 보안 jud-39558-649412ff0298) — 선택지 폐지로 <memoryRoot>/seats/OP 만 가능.
    const seat = 'OP';
    let plan: OpMemorySeedPlan;
    try {
      plan = planOpMemorySeed({
        claudeDir: opts.claudeDir, opsRulesPath: opts.opsRules, decisionsPath: opts.decisions, landingPath: opts.landing,
        allowedSourceRoots: [...OP_SEED_ALLOWED_SOURCE_ROOTS],
        to: seatMemoryDir(seat), seat,
        decisionsRecent: parseInt(opts.decisionsRecent, 10) || OP_SEED_DECISIONS_RECENT_DEFAULT,
      });
    } catch (error) { ui.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
    const applied = opts.apply ? applyOpMemorySeed(plan) : null;
    const summary = summarizeOpMemorySeed(plan, Boolean(applied));
    ui.header(`seat memory seed-op ${opts.apply ? '(applied)' : '(dry-run — nothing written)'} → ${plan.to}`);
    console.log(`  create ${summary.create} · update ${summary.update} · same ${summary.same} · skipped ${summary.skipped} · index lines dropped ${plan.indexDroppedLines}`);
    console.log(`  generated: ${summary.generated.join(', ') || 'none'}`);
    for (const [reason, count] of Object.entries(summary.skippedByReason)) console.log(`  skipped ${reason}: ${count}`);
    for (const name of summary.refusedNames) console.log(`  refused (secret-pattern): ${name}`);
    if (!opts.apply) console.log('  re-run with --apply to write');
  });

  memCmd
  .command('seat-index <seat>')
  .description('Print the session-start memory index block an eln seat session injects (or --rebuild it from the files)')
  .option('--rebuild', 'regenerate MEMORY.md from the memory files (loses hand-curated order)')
  .action((seatArg: string, opts: { rebuild?: boolean }) => {
    const seat = normalizeSeat(seatArg);
    if (!seat) { ui.error(`invalid seat "${seatArg}"`); process.exit(1); }
    const dir = seatMemoryDir(seat);
    if (opts.rebuild) ui.info(`rebuilt ${rebuildSeatMemoryIndex(dir).lines} lines → ${dir}`);
    const built = buildSeatMemoryIndexBlock(seat, dir);
    if (!built) { ui.info(`empty (no index at ${dir})`); return; }
    console.log(built.block);
    ui.info(`lines ${built.lines}/${built.totalLines} · bytes ${built.bytes}/${built.totalBytes} · truncated ${built.truncated}`);
  });

  // 대표 10-12 MEMORY-IMPORT-CLAUDE — Claude 자동 기억(~/.claude/projects/*/memory)을 엘라누스
  // 장기 기억으로 가져온다. 에이전트 무관 — codex·elanous TUI 가 같은 기억을 바로 읽는다.
  memCmd
  .command('import-claude')
  .description('Import Claude auto-memories (~/.claude/projects/*/memory) into elanous memories — same name overwrites')
  .option('--root <path>', 'projects root or a single memory dir', claudeMemoryRoot())
  .option('--as-of <date>', 'staleness basis «MM-DD 기준» (default: today)')
  .option('--dry-run', 'preview without saving')
  .action((opts: { root: string; asOf?: string; dryRun?: boolean }) => {
    const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
    const files = collectClaudeMemoryFiles(opts.root);
    if (opts.dryRun) {
      const preview = importClaudeMemories(files, { asOf });
      ui.header(`claude-memory (dry-run) ${files.length} files`);
      for (const item of preview.items) console.log(`  [${item.type.padEnd(9)}]  ${item.name}  ${item.summary}`);
      if (preview.overwritten) console.log(`  overwritten ${preview.overwritten}`);
      for (const [reason, count] of Object.entries(preview.skipped)) console.log(`  skipped ${reason}:${count}`);
      return;
    }
    const result = applyClaudeMemoryImport(files, { asOf }, {
      list: () => listMemories().map(entry => ({ id: entry.id, name: entry.name })),
      save: record => { saveMemory(record, undefined, { origin: 'memory-cli.import-claude' }); },
    });
    ui.info(`claude-memory: ${result.saved} new · ${result.updated} overwritten · ${result.items.length} imported (${files.length} files from ${opts.root})`);
    for (const [reason, count] of Object.entries(result.skipped)) ui.info(`  skipped ${reason}:${count}`);
  });
}
