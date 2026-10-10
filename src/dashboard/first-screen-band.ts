import { debug } from '../debug/log.js';
import { resolveCurrentInstance } from '../instance/current.js';
import { resolveDaemonEndpoint, type DaemonEndpoint } from '../nexus/daemon-endpoint.js';

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
    ? explicitRoot ? (CONTROL_CHARS.test(explicitRoot) ? '' : `elanous --test=${shellQuote(explicitRoot)} nexus run --hmr`) : 'elanous --test nexus run --hmr'
    : 'elanous nexus run --hmr';
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
  readonly pwa?: {
    readonly tailnet?: string | null;
    readonly lan?: string | null;
    readonly loopback?: string | null;
  };
}

// The link row contains Hangul (two terminal cells per syllable); count display cells, not UTF-16 units.
function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a
      || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
      || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
      || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
      || point >= 0x1f000 && point <= 0x1ffff)) width += 2;
    else if (point >= 0x300 && point <= 0x36f || point >= 0xfe00 && point <= 0xfe0f) continue;
    else width++;
  }
  return width;
}

function fitCells(text: string, limit: number): string {
  let result = '';
  for (const char of text) {
    if (cellWidth(result + char) > limit) break;
    result += char;
  }
  return result;
}

/** A startup transcript band; never includes credentials or a partial address. */
export function buildFirstScreenBand(input: FirstScreenBandInput): string[] {
  const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
  const fit = (text: string): string => text.slice(0, width);
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
  const fallback = input.pwa === undefined ? 'PWA: not checked' : 'PWA: unavailable';
  const addressLine = address ? `PWA: ${address}` : fallback;

  const daemonLine = (() => {
    const link = input.link;
    if (!link) return `elanous | daemon: ${input.daemon ? 'online' : 'offline'}`;
    if (link.status === 'checking') return 'elanous | 데몬: 확인 중';
    if (link.status === 'connected') {
      let address: string;
      try {
        const url = new URL(link.address);
        address = ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.origin : '';
      } catch { address = ''; }
      const line = `elanous | 데몬: 연결됨${address ? ` (${address})` : ''}`;
      return cellWidth(line) <= width ? line : 'elanous | 데몬: 연결됨';
    }
    if (link.status === 'error') return `elanous | 데몬: ${link.stage} 조회 오류`;
    const bare = `elanous | 데몬: ${link.status === 'absent' ? '없음' : '응답 없음'}`;
    if (!link.startCommand || CONTROL_CHARS.test(link.startCommand)) return bare;
    const line = `${bare} · 시작: ${link.startCommand}`;
    return cellWidth(line) <= width ? line : bare;
  })();

  return [
    input.link ? fitCells(daemonLine, width) : fit(daemonLine),
    addressLine.length <= width ? addressLine : fit(address ? 'PWA: address available' : fallback),
    fit('Type a message to begin | /help for commands'),
  ];
}
