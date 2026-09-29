// `elanous live detail` — 현재 우주에만 쓰고 운영 폴백은 읽기만 한다.
import type { Command } from 'commander';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import {
  LIVE_DETAIL_DEFAULT_TTL_MIN, LIVE_DETAIL_MAX_TTL_MIN,
  liveDetailPath, selectLiveDetail, writeLiveDetail,
} from '../live/detail-switch.js';

export interface LiveCliDeps {
  readonly localRoot?: () => string;
  readonly productionRoot?: () => string;
  readonly now?: () => number;
  readonly out?: { log: (line: string) => void; error: (line: string) => void };
}

export function registerLiveCommands(program: Command, deps: LiveCliDeps = {}): void {
  const out = deps.out ?? console;
  const localRoot = deps.localRoot ?? elanousStateRoot;
  const productionRoot = deps.productionRoot ?? prodInstanceRoot;
  const now = deps.now ?? Date.now;
  const detail = program.command('live').description('Live 상세 관측 스위치').command('detail').description('화려함 MAX 상세 판단 이벤트');
  for (const action of ['on', 'off', 'status'] as const) {
    detail.command(action)
      .description(action === 'on' ? '상세 관측 켜기' : action === 'off' ? '현재 우주에서 끄기' : '현재 상태 보기')
      .option('--scope <all|runId>', '적용 런 (기본 all)')
      .option('--ttl <minutes>', '켜 둘 분 (기본 30 · 최대 240)')
      .option('--json', 'JSON 출력')
      .action((opts: { scope?: string; ttl?: string; json?: boolean }) => {
        const scope = opts.scope ?? 'all';
        if (!/^(all|[\w.:-]{1,128})$/.test(scope)) { out.error('⛔ --scope 는 all 또는 유효한 runId'); process.exitCode = 2; return; }
        const ttl = opts.ttl === undefined ? LIVE_DETAIL_DEFAULT_TTL_MIN : Number(opts.ttl);
        if (opts.ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0 || ttl > LIVE_DETAIL_MAX_TTL_MIN || opts.ttl.trim() === '')) {
          out.error(`⛔ --ttl 은 0~${LIVE_DETAIL_MAX_TTL_MIN}분`); process.exitCode = 2; return;
        }
        if (action !== 'on' && opts.ttl !== undefined) { out.error('⛔ --ttl 은 on 에만 사용'); process.exitCode = 2; return; }
        const localPath = liveDetailPath(localRoot());
        const productionPath = liveDetailPath(productionRoot());
        const time = now();
        if (action !== 'status') writeLiveDetail({ scope, ttlMin: action === 'off' ? 0 : ttl, by: 'cli' }, { path: localPath, now: time });
        const { state, source, path } = selectLiveDetail({ path: localPath, prodPath: productionPath, now: time });
        const on = !!state && (opts.scope === undefined || state.scope === 'all' || state.scope === scope);
        const report = { on, scope: state?.scope ?? null, remainingMin: state ? Math.max(0, (state.until - time) / 60_000) : 0, source, path };
        if (opts.json) out.log(JSON.stringify(report));
        else out.log(`Live detail: ${on ? 'on' : 'off'} · 남은 분: ${Math.round(report.remainingMin)} · 출처: ${source === 'local' ? '자기 우주' : source === 'production' ? '운영 폴백' : '없음'}${path ? ` (${path})` : ''}`);
      });
  }
}
