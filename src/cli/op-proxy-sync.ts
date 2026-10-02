import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACP_TOKEN_FILE } from '../auth/token-store.js';
import { debug } from '../debug/log.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { userConfigPath } from '../user-config.js';

export interface OpProxyConfig {
  host: string;
  bearerFile: string;
  restart: string;
}

/** Read the optional, unnormalized nexus setting from the same config file as the CLI. */
export function readOpProxyConfig(path = userConfigPath()): OpProxyConfig | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { nexus?: { opProxy?: OpProxyConfig } };
    return raw?.nexus?.opProxy;
  } catch {
    return undefined;
  }
}

type SshExecutor = (argv: string[], input: string) => { status: number | null; error?: Error };

export function finishOpProxyRotation(
  proxy: OpProxyConfig | undefined,
  token: string,
  opts: { sync: boolean; ssh?: SshExecutor; tokenFile?: string; out?: (line: string) => void },
): boolean | undefined {
  if (!proxy) return undefined;
  if (!opts.sync) {
    (opts.out ?? console.log)('op 프록시 토큰도 갈아야 합니다 — `elanous token rotate --sync-op-proxy`');
    return undefined;
  }
  return syncOpProxyToken(proxy, token, opts);
}

const executeSsh: SshExecutor = (argv, input) => {
  const result = spawnSync('ssh', argv, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  return { status: result.status, ...(result.error ? { error: result.error } : {}) };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Never interpolate the token in a command, diagnostic, or log. Only SSH stdin carries it. */
export function syncOpProxyToken(
  proxy: OpProxyConfig | undefined,
  token: string,
  opts: { ssh?: SshExecutor; tokenFile?: string; out?: (line: string) => void } = {},
): boolean | undefined {
  if (!proxy) return undefined;
  const out = opts.out ?? console.log;
  const host = typeof proxy.host === 'string' ? proxy.host : '';
  const file = typeof proxy.bearerFile === 'string' ? proxy.bearerFile : '';
  const service = typeof proxy.restart === 'string' ? proxy.restart : '';
  const valid = /^[\w][\w.-]*$/.test(host) && file.startsWith('/') && !/[\r\n\0]/.test(file)
    && /^[\w@][\w@.-]*$/.test(service) && !/[\r\n\0]/.test(opts.tokenFile ?? '');
  const remote = `sudo install -m 600 /dev/stdin ${shellQuote(file)} && sudo systemctl restart ${shellQuote(service)}`;
  const manual = valid
    ? `token=$(head -n 1 < ${shellQuote(opts.tokenFile ?? join(getElanousConfigDir(), ACP_TOKEN_FILE))}) && [ -n "$token" ] && printf 'ELANOUS_OP_BEARER=%s\\n' "$token" | ssh ${shellQuote(host)} ${shellQuote(remote)}`
    : 'nexus.opProxy 의 host, bearerFile, restart 를 확인한 뒤 bearer 파일을 갱신하고 서비스를 재시작하세요';
  let reason = '';
  if (!valid) {
    reason = 'nexus.opProxy 설정 오류';
  } else {
    try {
      const result = (opts.ssh ?? executeSsh)([host, remote], `ELANOUS_OP_BEARER=${token}\n`);
      if (result.status === 0 && !result.error) {
        debug.log('auth.op-proxy-sync', 'synced', { host, reason: 'ok' });
        out(`op 프록시 토큰을 바꿨습니다(${host})`);
        return true;
      }
      reason = result.error ? 'ssh 실행 실패' : `ssh 종료 코드 ${result.status ?? '미상'}`;
    } catch {
      reason = 'ssh 실행 실패';
    }
  }
  debug.log('auth.op-proxy-sync', 'failed', { host, reason });
  out(`op 프록시 토큰 동기화 실패(${host}): ${reason} — 직접: ${manual}`);
  return false;
}
