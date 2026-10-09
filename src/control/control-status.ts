import { readHqLease } from '../hq/hq.js';
import { fileLeaseStore } from '../hq/lease.js';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { readLandingFreeze } from '../release-loop/landing-freeze.js';
import { entriesFromRegistry, checkLoops, countLoopStates } from '../loops/checker.js';
import { computeDrift, discoverUniverses } from '../cli/config-drift.js';
import { debug } from '../debug/log.js';

export type ControlStatusState = 'ok' | 'warn' | 'unmeasured';
export type ControlStatusRowName = '집' | '판' | '자원' | '자격' | '동결·몫' | '루프' | 'config';
export interface ControlStatusRow {
  row: ControlStatusRowName;
  state: ControlStatusState;
  text: string;
  reason?: string;
}

export interface ControlStatusDeps {
  readLease?: () => ReturnType<typeof readHqLease> | Promise<ReturnType<typeof readHqLease>>;
  readVersion?: () => ControlStatusRow | Promise<ControlStatusRow>;
  readResources?: () => ControlStatusRow | Promise<ControlStatusRow>;
  readCredentials?: () => ControlStatusRow | Promise<ControlStatusRow>;
  readFreeze?: () => ReturnType<typeof readLandingFreeze> | Promise<ReturnType<typeof readLandingFreeze>>;
  readLoops?: () => ReturnType<typeof entriesFromRegistry> | Promise<ReturnType<typeof entriesFromRegistry>>;
  readDrift?: () => ReturnType<typeof computeDrift> | Promise<ReturnType<typeof computeDrift>>;
  now?: () => Date;
  log?: typeof debug.log;
}

const missing = (row: ControlStatusRowName, reason: string): ControlStatusRow => ({ row, state: 'unmeasured', text: '못 쟀다', reason });

/** Read-only snapshot: each source fails independently; no lease renewal, freeze mutation or config sync. */
export async function collectControlStatus(deps: ControlStatusDeps = {}): Promise<ControlStatusRow[]> {
  const rows: ControlStatusRow[] = [];
  const add = async (row: ControlStatusRowName, read: () => ControlStatusRow | Promise<ControlStatusRow>) => {
    let result: ControlStatusRow;
    try { result = await read(); }
    catch (error) {
      // Source errors may contain file contents or credentials; report the failure class, not the raw message.
      result = missing(row, error instanceof Error ? `읽기 실패(${error.name})` : '읽기 실패');
    }
    rows.push(result);
    try { (deps.log ?? debug.log.bind(debug))('control.status', 'row', { row, state: result.state }); }
    catch { /* logging must not mask another row */ }
  };

  await add('집', async () => {
    const readLease = deps.readLease ?? (() => readHqLease(getElanousConfigDirOverride() !== undefined
      ? { store: fileLeaseStore(join(effectiveInstanceRoot(), 'hq', 'lease.json')), hostPath: join(effectiveInstanceRoot(), 'hq', 'host') }
      : {}));
    const { record, ageSeconds, expired } = await readLease();
    if (!record) return missing('집', '본부 임대 기록 없음');
    return { row: '집', state: expired ? 'warn' : 'ok',
      text: `본부 ${record.holder} · 세대 ${record.generation} · ${ageSeconds}초 전 · ${expired ? '만료' : '유효'}` };
  });
  await add('판', deps.readVersion ?? (() => missing('판', '기계별 install.json·데몬 판·공개 판 원천 미연결')));
  await add('자원', deps.readResources ?? (() => missing('자원', '기계별 Pod 실행/대기/실패·풀 상한·호스트 부하 원천 미연결')));
  await add('자격', deps.readCredentials ?? (() => missing('자격', '계정별 만료·쿼터·갱신자 원천 미연결')));
  await add('동결·몫', async () => {
    const freeze = await (deps.readFreeze ?? readLandingFreeze)();
    return { row: '동결·몫', state: freeze ? 'warn' : 'unmeasured',
      text: freeze ? `동결 켬 · ${freeze.reason} · 끝 ${freeze.until ?? '미지정'} · 자리별 몫 못 쟀다` : '동결 끔 · 자리별 몫 못 쟀다',
      reason: '자리별 몫/도는 수 원천 미연결' };
  });
  await add('루프', async () => {
    const { entries, scope } = await (deps.readLoops ?? entriesFromRegistry)();
    if (entries.length === 0) return missing('루프', `${scope} 루프 목록에 측정 대상 없음`);
    const results = checkLoops(entries, (deps.now ?? (() => new Date()))());
    const counts = countLoopStates(results);
    if (counts.unknown + counts.unregistered + counts.off === results.length) return missing('루프', '활성 등록 루프의 마지막 실행/예정 시각을 잴 수 없음');
    const failing = results.filter(result => result.state === 'failing').map(result => result.id);
    const late = results.filter(result => result.state === 'late').map(result => result.id);
    return { row: '루프', state: failing.length || late.length || counts.unknown || counts.unregistered || counts.off ? 'warn' : 'ok',
      text: `failing ${counts.failing}${failing.length ? ` (${failing.join(', ')})` : ''} · late ${counts.late}${late.length ? ` (${late.join(', ')})` : ''} · unknown ${counts.unknown} · unregistered ${counts.unregistered} · off ${counts.off}` };
  });
  await add('config', async () => {
    const report = await (deps.readDrift ?? (() => computeDrift(discoverUniverses(getElanousConfigDirOverride() !== undefined
      ? { prodRoot: effectiveInstanceRoot(), registryPath: null, treeScanRoots: [] } : {}))))();
    if (report.prodStatus !== 'ok' || !report.registry.ok || report.universes.unreadable > 0 || report.universes.compared === 0) {
      return missing('config', `드리프트 비교 불가(집 ${report.prodStatus} · 레지스트리 ${report.registry.ok ? '읽음' : '못 읽음'} · 비교 ${report.universes.compared} · 못 읽은 우주 ${report.universes.unreadable})`);
    }
    return { row: 'config', state: report.rows.length ? 'warn' : 'ok', text: `드리프트 키 ${report.rows.length}` };
  });
  return rows;
}
