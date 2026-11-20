import type { Command } from 'commander';
import { desiredSha as readDesiredSha } from '../els/build-badge.js';
import { classifyHost, DEFAULT_STALE_MS } from '../nexus/host-registry/classify.js';
import { hostLedgerPath, isHostRecord, readHostLedger, recordHeartbeat } from '../nexus/host-registry/store.js';
import type { HostChannel, HostLedger } from '../nexus/host-registry/types.js';

export interface HostsCliDeps {
  readLedger?: () => HostLedger | undefined;
  desired?: () => string | undefined;
  now?: () => number;
  ledgerPath?: () => string;
  write?: (line: string) => void;
}

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

export function renderHostsList(ledger: HostLedger | undefined, desired: string | undefined, now: number, json = false): string {
  if (!ledger) return json ? JSON.stringify({ outcome: 'unmeasured', hosts: [] }) : 'unmeasured · 호스트 원장 없음';
  const rows = Object.values(ledger.hosts).filter(isHostRecord).sort((a, b) => a.host.localeCompare(b.host)).map((r) => ({
    host: r.host, seat: r.seat ?? null, channel: r.channel, installed: r.installedSha, desired: desired ?? null,
    state: classifyHost(r, desired, now, DEFAULT_STALE_MS), heartbeatAgeMs: now - r.lastHeartbeatMs,
  }));
  if (json) return JSON.stringify({ outcome: 'measured', hosts: rows });
  const short = (s: string | null): string => (s ? s.slice(0, 10) : '-');
  const lines = [['HOST', 'SEAT', 'INSTALLED', 'DESIRED', 'STATE', 'HEARTBEAT'].join('\t')];
  for (const r of rows) lines.push([r.host, r.seat ?? '-', short(r.installed), short(r.desired), r.state === 'behind' ? 'behind !' : r.state, age(r.heartbeatAgeMs)].join('\t'));
  return lines.join('\n');
}

export function registerHostsCommands(program: Command, deps: HostsCliDeps = {}): void {
  const hosts = program.command('hosts').description('원격 호스트 설치본(installedSha) 원장');
  hosts.command('list')
    .description('호스트별 설치본·목표(desiredSha)·상태·하트비트 나이')
    .option('--json', '구조화 출력')
    .action((opts: { json?: boolean }) => {
      const write = deps.write ?? ((line: string) => console.log(line));
      write(renderHostsList((deps.readLedger ?? (() => readHostLedger()))(), (deps.desired ?? (() => readDesiredSha()))(), (deps.now ?? Date.now)(), opts.json));
    });
  hosts.command('heartbeat')
    .description('호스트가 자기 설치본(installedSha)을 원장에 보고 (원장 갱신 생산 경로)')
    .requiredOption('--host <name>', '호스트 이름')
    .requiredOption('--installed-sha <sha>', '설치본 40-hex sha')
    .option('--seat <seat>', '자리')
    .option('--channel <channel>', 'dev | release (생략하면 이전 값 유지, 없으면 unknown)')
    .action((opts: { host: string; installedSha: string; seat?: string; channel?: string }) => {
      const write = deps.write ?? ((line: string) => console.log(line));
      if (opts.channel !== undefined && opts.channel !== 'dev' && opts.channel !== 'release') {
        write(`--channel 은 dev | release 만: ${opts.channel}`);
        process.exitCode = 1;
        return;
      }
      const path = (deps.ledgerPath ?? hostLedgerPath)();
      try {
        const r = recordHeartbeat(opts.host, opts.installedSha, (deps.now ?? Date.now)(), {
          path, seat: opts.seat, channel: opts.channel as HostChannel | undefined, desiredSha: (deps.desired ?? (() => readDesiredSha()))(),
        });
        write(`${r.host}\t${r.channel}\t${r.installedSha.slice(0, 10)}\t${r.state}`);
      } catch (e) {
        write(`heartbeat 실패 · 원장 보존: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
