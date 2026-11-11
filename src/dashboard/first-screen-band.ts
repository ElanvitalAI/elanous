import { debug } from '../debug/log.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { resolveDaemonEndpoint, type DaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { firstScreenCellWidth as cellWidth, fitFirstScreenCells as fitCells, firstScreenGuidanceLines } from '../tui-client/first-screen-guidance.js';

export type TuiDaemonLink =
  | { readonly status: 'checking' }
  | { readonly status: 'connected'; readonly address: string }
  | { readonly status: 'absent' | 'unhealthy'; readonly startCommand: string }
  | { readonly status: 'error'; readonly stage: 'endpoint' | 'health' | 'identity' };

export interface TuiDaemonLinkDeps {
  readonly endpoint?: () => Pick<DaemonEndpoint, 'baseUrl' | 'healthUrl' | 'source'> | null;
  readonly probe?: (url: string, init: RequestInit) => Promise<Response>;
  readonly universe?: () => 'test' | 'prod';
  /** An explicitly chosen test root (`--test=<root>` / parent stamp); bare `--test` cannot name it. */
  readonly testRoot?: () => string | undefined;
  readonly observe?: (data: {
    status: TuiDaemonLink['status'];
    stage: 'endpoint' | 'health' | 'identity';
    universe: 'test' | 'prod' | 'unknown';
    source: 'registry' | 'lifecycle' | 'none';
  }) => void;
}

// C0/C1 controls incl. ESC (ANSI sequences), newline and DEL.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Probe the write target in this universe only; never use a watch/production fallback. */
export async function resolveTuiDaemonLink(deps: TuiDaemonLinkDeps = {}): Promise<TuiDaemonLink> {
  const universe = deps.universe ?? (() => resolveCurrentInstance().kind === 'test' ? 'test' : 'prod');
  const observe = deps.observe ?? ((data) => debug.log('dashboard.tui-daemon-link', 'resolved', data));
  let kind: 'test' | 'prod' | 'unknown' = 'unknown';
  let source: 'registry' | 'lifecycle' | 'none' = 'none';
  const finish = (result: TuiDaemonLink, stage: 'endpoint' | 'health' | 'identity'): TuiDaemonLink => {
    try { observe({ status: result.status, stage, universe: kind, source }); } catch { /* observation is fail-soft */ }
    return result;
  };
  try {
    kind = universe();
  } catch {
    return finish({ status: 'error', stage: 'identity' }, 'identity');
  }
  let explicitRoot: string | undefined;
  if (kind === 'test') {
    try {
      // An injected identity comes with its own root (or none); only the real identity reads the real root.
      explicitRoot = (deps.testRoot ?? (deps.universe ? () => undefined : () => {
        const resolution = resolveCurrentInstance();
        return resolution.layer === 'explicit-flag' || resolution.layer === 'parent-stamp' ? resolution.root : undefined;
      }))();
    } catch {
      return finish({ status: 'error', stage: 'identity' }, 'identity');
    }
  }
  // The start command must name *this* universe: a custom test root is passed as one literal shell argument.
  // A root with control characters cannot be shown safely (it would rewrite the screen): name no command at all.
  const startCommand = kind === 'test'
    ? explicitRoot ? (CONTROL_CHARS.test(explicitRoot) ? '' : `elanous --test=${shellQuote(explicitRoot)} nexus run`) : 'elanous --test nexus run'
    : 'elanous nexus run';
  let endpoint: ReturnType<NonNullable<TuiDaemonLinkDeps['endpoint']>>;
  try {
    endpoint = (deps.endpoint ?? (() => resolveDaemonEndpoint({ purpose: 'write' })))();
    if (!endpoint) return finish({ status: 'absent', startCommand }, 'endpoint');
    source = endpoint.source;
  } catch {
    return finish({ status: 'error', stage: 'endpoint' }, 'endpoint');
  }
  let address: string;
  let healthAddress: string;
  try {
    const url = new URL(endpoint.baseUrl);
    const healthUrl = new URL(endpoint.healthUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || healthUrl.origin !== url.origin
      || healthUrl.username || healthUrl.password || healthUrl.pathname !== '/v1/health'
      || healthUrl.search || healthUrl.hash) {
      return finish({ status: 'error', stage: 'endpoint' }, 'endpoint');
    }
    address = url.origin;
    healthAddress = `${address}/v1/health`;
  } catch {
    return finish({ status: 'error', stage: 'endpoint' }, 'endpoint');
  }
  try {
    const response = await (deps.probe ?? fetch)(healthAddress, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return finish({ status: 'unhealthy', startCommand }, 'health');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) {
      return finish({ status: 'unhealthy', startCommand }, 'health');
    }
    // «Connected» is a claim about *this* universe: the daemon must state its universe and it must match.
    if (!('testUniverse' in body) || typeof body.testUniverse !== 'boolean' || body.testUniverse !== (kind === 'test')) {
      return finish({ status: 'error', stage: 'identity' }, 'identity');
    }
    return finish({ status: 'connected', address }, 'health');
  } catch {
    return finish({ status: 'error', stage: 'health' }, 'health');
  }
}

export interface FirstScreenBandInput {
  readonly width: number;
  readonly daemon: boolean;
  readonly link?: TuiDaemonLink;
  /** Renders the three available-action rows and the example row in this locale; `undefined` keeps the historical band. */
  readonly locale?: 'ko' | 'en';
  readonly pwa?: {
    readonly tailnet?: string | null;
    readonly lan?: string | null;
    readonly loopback?: string | null;
  };
}

/** A startup transcript band; never includes credentials or a partial address. */
export function buildFirstScreenBand(input: FirstScreenBandInput): string[] {
  const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
  // The historical band is mixed: the link row speaks Korean, the remaining lines English.
  // An explicit locale unifies them; `undefined` must keep every pinned line byte-identical.
  const linkKorean = input.locale !== 'en';
  const plainKorean = input.locale === 'ko';
  const address = [input.pwa?.tailnet, input.pwa?.lan, input.pwa?.loopback]
    .map((candidate) => {
      if (!candidate) return null;
      try {
        const url = new URL(candidate);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
        return `${url.origin}${url.pathname === '/app/' ? '/app/' : ''}`;
      } catch {
        return null;
      }
    })
    .find((candidate) => candidate !== null);
  const fallback = input.pwa === undefined
    ? (plainKorean ? 'PWA: 확인 안 함' : 'PWA: not checked')
    : (plainKorean ? 'PWA: 사용할 수 없음' : 'PWA: unavailable');
  const addressLine = address ? `PWA: ${address}` : fallback;

  const daemonLine = (() => {
    const link = input.link;
    if (!link) return plainKorean
      ? `elanous | 데몬: ${input.daemon ? '켜짐' : '꺼짐'}`
      : `elanous | daemon: ${input.daemon ? 'online' : 'offline'}`;
    if (link.status === 'checking') return linkKorean ? 'elanous | 데몬: 확인 중' : 'elanous | daemon: checking';
    if (link.status === 'connected') {
      let address: string;
      try {
        const url = new URL(link.address);
        address = ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.origin : '';
      } catch { address = ''; }
      const bare = linkKorean ? 'elanous | 데몬: 연결됨' : 'elanous | daemon: connected';
      const line = `${bare}${address ? ` (${address})` : ''}`;
      return cellWidth(line) <= width ? line : bare;
    }
    if (link.status === 'error') {
      return linkKorean ? `elanous | 데몬: ${link.stage} 조회 오류` : `elanous | daemon: ${link.stage} lookup error`;
    }
    // Startup commands are operator detail. Keep the first screen focused on the user's next step.
    return linkKorean ? '웹 화면을 여는 중…' : 'Opening web setup…';
  })();

  const hintLine = 'Type a message to begin | /help for commands';

  const statusRows = [
    fitCells(daemonLine, width),
    cellWidth(addressLine) <= width
      ? addressLine
      : fitCells(address ? (plainKorean ? 'PWA: 주소 확인됨' : 'PWA: address available') : fallback, width),
  ];
  // The historical band folds its guidance into one mixed-language hint row.
  // An explicit locale renders the same guidance as three available-action rows
  // plus one immediately-typeable example row, in that locale — on every screen
  // state (empty, checking, absent, unhealthy, error) because none of these
  // rows depends on the daemon link or the PWA lookup.
  const guidanceRows = input.locale
    ? firstScreenGuidanceLines(input.locale, width)
    : [fitCells(hintLine, width)];
  return [...statusRows, ...guidanceRows];
}
