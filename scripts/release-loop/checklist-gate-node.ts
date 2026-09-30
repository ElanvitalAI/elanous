#!/usr/bin/env bun
import { addItem, checklistGate, listChecklist, summarizeChecklist } from '../../src/release-loop/checklist.js';
import { emitNodeResult, errorResult, readGraphContext, type GraphContext } from './node-verdict.js';

export function runChecklistGate(context: GraphContext = readGraphContext()) {
  const version = context.input.version;
  const data = listChecklist(version);
  const gate = checklistGate(version);
  const counts = summarizeChecklist(data);
  const summary = `확인표 🟢${counts.green} 🟡${counts.yellow}(이동 ${gate.moved.length} · 알려진 문제 ${gate.knownIssues.length} · 막음 ${gate.blocked.length} · 판정 없음 ${gate.undecided.length}) 🔴${counts.red}${gate.red.length ? ` (${gate.red.join(', ')})` : ''}`;
  if (gate.ok && gate.moved.length) {
    const [major, minor, patch] = version.split('.').map(Number);
    const next = `${major}.${minor}.${patch! + 1}`;
    for (const id of gate.moved) {
      const item = data.items.find((candidate) => candidate.id === id)!;
      if (listChecklist(next).items.some((candidate) => candidate.id === id)) continue;
      try { addItem(next, { id, title: item.title, ...(item.owner !== undefined ? { owner: item.owner } : {}) }); }
      catch (error) {
        if (!listChecklist(next).items.some((candidate) => candidate.id === id)) throw error;
      }
    }
  }
  return { outcome: gate.ok ? 'ok' as const : 'fail' as const, verdict: gate.ok ? 'pass' as const : 'fail' as const, summary, ...gate };
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
