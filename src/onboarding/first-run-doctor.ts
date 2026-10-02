import { delimiter, join, win32 } from 'node:path';
import { applyDoctorFixes, planDoctorFixes, type DoctorFixDeps, type DoctorFixItem } from '../cli/doctor-fix.js';
import { staticToolBinDir } from '../cli/doctor-static-tools.js';
import { debug } from '../debug/log.js';

const AUTOMATIC = new Set<DoctorFixItem['id']>(['private-files', 'key-cache-permissions', 'static-tools']);
const DEFERRED = new Set<DoctorFixItem['id']>(['install-path', 'bun-tmpdir']);
const LATER_LINE = '나중에: elanous doctor --fix (셸 시작 파일 수정)';

export interface FirstRunDoctorResult {
  fixed: string[];
  skipped: string[];
  failed: string[];
  later: string[];
  lines: string[];
}

/** 첫 실행에서는 동의가 필요 없는 수리만 실행하고, 셸 시작 파일은 손대지 않는다. */
export function runFirstRunDoctor(deps: DoctorFixDeps): FirstRunDoctorResult {
  const result: FirstRunDoctorResult = { fixed: [], skipped: [], failed: [], later: [], lines: [] };
  const record = (id: string, outcome: 'fixed' | 'skipped' | 'failed', reason?: string) => {
    result[outcome].push(id);
    if (outcome === 'failed') result.lines.push(`doctor: ${id} 수리 실패 — ${reason || '원인 불명'}`);
    try { debug.log('doctor.first-run', outcome, { id }); } catch { /* 관측 실패가 첫 실행을 막지 않는다. */ }
  };

  try {
    const windows = deps.readiness?.platform === 'win32';
    const prefix = deps.readiness?.installPrefix;
    const bin = typeof prefix === 'string' && prefix.trim()
      ? windows ? win32.join(prefix.trim(), 'bin') : join(prefix.trim(), 'bin')
      : staticToolBinDir(deps.env ?? process.env, deps.home);
    const separator = windows ? ';' : delimiter;
    const entries = (process.env.PATH ?? '').split(separator);
    if (!entries.some((entry) => windows ? entry.toLowerCase() === bin.toLowerCase() : entry === bin)) {
      process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(separator);
    }

    const plan = planDoctorFixes(deps);
    for (const item of plan.items) {
      if (DEFERRED.has(item.id) && item.status === 'fixable') result.later.push(item.id);
    }
    const applied = applyDoctorFixes(deps, true, AUTOMATIC);
    for (const item of applied.items) {
      if (AUTOMATIC.has(item.id) && item.result === 'failed') record(item.id, 'failed', item.reason);
      else if (AUTOMATIC.has(item.id) && item.result === 'fixed') record(item.id, 'fixed');
      else record(item.id, 'skipped');
    }
  } catch {
    record('doctor', 'failed', '계획 또는 적용 중 예외');
  }
  if (result.later.length) result.lines.push(LATER_LINE);
  return result;
}
