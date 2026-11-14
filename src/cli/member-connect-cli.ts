import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { connectApprovedMemberSession } from './member-connect.js';

function readApprovedHandoff(path: string): { code: string; state: string; codeVerifier: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) || stat.size < 1 || stat.size > 4096) throw new Error();
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count < 1 || count > 4096) throw new Error();
    const value: unknown = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || Object.keys(item).some(key => !['code', 'state', 'codeVerifier'].includes(key)) ||
        ['code', 'state', 'codeVerifier'].some(key => typeof item[key] !== 'string' || !item[key] || (item[key] as string).length > 128)) throw new Error();
    return item as { code: string; state: string; codeVerifier: string };
  } finally { closeSync(fd); }
}

/** A real consumer for an approved callback file; this command does not initiate or fake app approval. */
export function registerMemberConnectCommands(program: Command, deps: {
  configDir?: () => string;
  fetchImpl?: typeof fetch;
  output?: { log(message: string): void; error(message: string): void };
  exit?: (code: number) => void;
} = {}): void {
  const io = deps.output ?? console;
  const exit = deps.exit ?? (code => { process.exitCode = code; });
  const member = program.commands.find(command => command.name() === 'member')
    ?? program.command('member').description('Manage member credentials and approved app-session handoffs.');
  const connect = member.command('connect').description('Consume an approved private PKCE handoff; browser approval must already exist.')
    .requiredOption('--handoff-file <path>', 'Owner-only 0600 callback file with code, state and codeVerifier')
    .allowExcessArguments(false);
  connect.error = (_message, options) => program.error('회원 연결 명령이 올바르지 않습니다.', options);
  connect.action(async (options: { handoffFile: string }) => {
    try {
      const approved = readApprovedHandoff(options.handoffFile);
      await connectApprovedMemberSession({ ...approved, nexusUrl: 'https://api.elanous.ai',
        configDir: (deps.configDir ?? getElanousConfigDir)(), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      io.log('회원 앱 세션을 연결했습니다.');
      exit(0);
    } catch { io.error('회원 연결을 완료하지 못했습니다. 승인된 private handoff와 기존 연결을 확인해 주세요.'); exit(1); }
  });
}
