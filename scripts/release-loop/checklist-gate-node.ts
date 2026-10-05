#!/usr/bin/env bun
import { checklistGate, listChecklist, summarizeChecklist } from '../../src/release-loop/checklist.js';
import * as store from '../../src/release-loop/feature-store.js';
import { getSchedule } from '../../src/release-loop/release-schedule.js';
import { debug } from '../../src/debug/log.js';
import { emitNodeResult, errorResult, readGraphContext, type GraphContext } from './node-verdict.js';

export function runChecklistGate(context: GraphContext = readGraphContext(), now: Date = new Date()) {
  const version = context.input.version;
  const data = listChecklist(version);
  const schedule = getSchedule(version);
  const deadline = schedule?.landBy;
  const overdue = deadline !== null && deadline !== undefined && now.getTime() > Date.parse(deadline);
  const autoMoved = overdue ? data.items.filter((item) => item.status === 'yellow' && item.priority !== 'P0' && item.disposition === undefined).map((item) => item.id) : [];
  const gate = checklistGate(version);
  const p0 = data.items.filter((item) => item.status === 'yellow' && item.priority === 'P0').map((item) => item.id);
  gate.undecided = gate.undecided.filter((id) => !autoMoved.includes(id) && !p0.includes(id));
  gate.moved = gate.moved.filter((id) => !p0.includes(id)).concat(autoMoved);
  gate.knownIssues = gate.knownIssues.filter((item) => !p0.includes(item.id));
  gate.blocked.push(...p0.filter((id) => !gate.blocked.includes(id)));
  gate.ok = gate.red.length === 0 && gate.undecided.length === 0 && gate.blocked.length === 0;
  const [major, minor, patch] = version.split('.').map(Number);
  const next = `${major}.${minor}.${patch! + 1}`;
  const carried: string[] = [];
  let carryFailure: string | undefined;
  if (gate.moved.length) {
    const nextChecklist = listChecklist(next);
    const existing = new Map(nextChecklist.items.map((item) => [item.id, item]));
    const movedFromHere = new Set(nextChecklist.history.filter((entry) => entry.field === 'move' && entry.from === version).map((entry) => entry.id));
    const sameCarry = new Set<string>();
    for (const id of gate.moved) {
      const original = data.items.find((item) => item.id === id)!;
      const destination = existing.get(id);
      if (!destination) continue;
      if (destination.title === original.title && destination.owner === original.owner && (movedFromHere.has(id) || destination.evidence?.split('\n').some((line) => line.startsWith(`${version}에서 이월`)))) {
        sameCarry.add(id);
      } else {
        carryFailure = `이월 충돌: ${id} — 다음 판에 다른 칸이 같은 ID`;
        debug.log('release-loop.checklist-gate', 'carry-collision', { id, from: version, to: next });
        break;
      }
    }
    if (!carryFailure) for (const id of gate.moved) {
      try {
        if (sameCarry.has(id)) {
          store.remove(version, id, 'release-loop.checklist-gate');
          debug.log('release-loop.checklist-gate', 'carry-closed', { id, from: version, to: next });
        } else {
          const reason = autoMoved.includes(id) ? `컷 자동 이월 · 마감 ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(deadline!))}` : '컷 자동 이월 · 처분 move';
          store.move(id, version, next, 'release-loop.checklist-gate', undefined, undefined, reason, { clearDisposition: true });
          carried.push(id);
          debug.log('release-loop.checklist-gate', 'carried', { id, from: version, to: next });
        }
      } catch (error) {
        carryFailure = `이월 실패: ${id} — ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
  }
  if (carryFailure) gate.ok = false;
  const counts = summarizeChecklist(data);
  const summary = `${carryFailure ? `${carryFailure} · ` : ''}확인표 🟢${counts.green} 🟡${counts.yellow}(이동 ${gate.moved.length} · 알려진 문제 ${gate.knownIssues.length} · 막음 ${gate.blocked.length} · 판정 없음 ${gate.undecided.length}) 🔴${counts.red}${gate.red.length ? ` (${gate.red.join(', ')})` : ''}${gate.parity?.length ? ` · ⚠ 짝 경고 ${gate.parity.length}(${gate.parity.map((p) => p.id).join(', ')})` : ''} · 이월 ${carried.length}(${carried.join(', ') || '-'})`;
  return { outcome: gate.ok ? 'ok' as const : 'fail' as const, verdict: gate.ok ? 'pass' as const : 'fail' as const, summary, ...gate, carried };
}

if (import.meta.main) {
  try {
    const result = runChecklistGate();
    emitNodeResult(result);
    process.exitCode = result.outcome === 'ok' ? 0 : 1;
  } catch (error) {
    emitNodeResult(errorResult(error));
    process.exitCode = 2;
  }
}
