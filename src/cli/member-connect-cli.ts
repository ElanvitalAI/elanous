import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { connectApprovedMemberSession } from './member-connect.js';
import { MemberConnectStageError, startApprovedMemberConnect } from './member-connect-start.js';

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

const GENERIC_CONNECT_FAILURE = '회원 연결을 완료하지 못했습니다. 승인된 private handoff와 기존 연결을 확인해 주세요.';

function memberConnectDiagnostic(error: unknown): string {
  if (!(error instanceof MemberConnectStageError)) {
    if (!(error instanceof Error)) return GENERIC_CONNECT_FAILURE;
    // The SDK currently uses plain Error. Recognize only these exact local
    // literals; never print an unknown exception message or server body.
    switch (error.message) {
      case '회원 서비스가 설정되지 않았습니다. 설치 관리자에게 설정을 요청해 주세요.':
        return '회원 서비스가 설정되지 않았습니다. 설치 관리자에게 설정을 요청해 주세요.';
      case '회원 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.':
        return '회원 서비스를 사용할 수 없습니다. 잠시 후 다시 연결해 주세요.';
      case '회원 연결을 확인하지 못했습니다. 다시 로그인해 주세요.':
        return '회원 연결 응답을 확인하지 못했습니다. 네트워크를 확인하고 다시 로그인해 주세요.';
      case '회원 연결이 만료되었거나 거부되었습니다. 다시 로그인해 주세요.':
        return '회원 연결 승인이 만료되었거나 거부되었습니다. 다시 로그인하고 연결해 주세요.';
      case '회원 소유자를 확인하지 못했습니다. 다시 로그인해 주세요.':
      case '회원 소유자 응답이 올바르지 않습니다.':
        return '회원 소유자를 확인하지 못했습니다. 같은 계정으로 다시 로그인한 뒤 연결해 주세요.';
      case '이미 회원 연결이 있습니다. 기존 연결을 먼저 확인해 주세요.':
        return '이미 회원 연결이 있습니다. 기존 연결을 먼저 확인해 주세요.';
      case '회원 연결을 안전하게 저장하지 못했습니다.':
        return '회원 연결을 저장하지 못했습니다. 저장 경로와 권한을 확인한 뒤 다시 연결해 주세요.';
      default: return GENERIC_CONNECT_FAILURE;
    }
  }
  switch (error.code) {
    case 'start-unavailable': return '회원 연결 요청을 시작하지 못했습니다. 네트워크와 회원 서비스 상태를 확인한 뒤 다시 시도해 주세요.';
    case 'poll-unavailable': return '회원 승인 상태를 확인하지 못했습니다. 네트워크와 회원 서비스 상태를 확인한 뒤 다시 연결해 주세요.';
    case 'approval-refused': return '회원 연결 승인이 거부되었습니다. 같은 계정으로 브라우저에 로그인한 뒤 다시 연결해 주세요.';
    case 'approval-expired': return '회원 연결 승인이 만료되었습니다. 연결 명령을 다시 실행하고 새 주소에서 승인해 주세요.';
    case 'approval-invalid': return '회원 연결 승인 응답을 확인하지 못했습니다. 연결 명령을 다시 실행해 주세요.';
    default: return GENERIC_CONNECT_FAILURE;
  }
}

/** A real consumer for an approved callback file; this command does not initiate or fake app approval. */
export function registerMemberConnectCommands(program: Command, deps: {
  configDir?: () => string;
  fetchImpl?: typeof fetch;
  output?: { log(message: string): void; error(message: string): void };
  exit?: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
} = {}): void {
  const io = deps.output ?? console;
  const exit = deps.exit ?? (code => { process.exitCode = code; });
  const member = program.commands.find(command => command.name() === 'member')
    ?? program.command('member').description('Manage member credentials and approved app-session handoffs.');
  const connect = member.command('connect').description('Start browser approval, or consume an existing private PKCE handoff.')
    .option('--handoff-file <path>', 'Owner-only 0600 callback file with code, state and codeVerifier')
    .allowExcessArguments(false);
  connect.error = (_message, options) => program.error('회원 연결 명령이 올바르지 않습니다.', options);
  connect.action(async (options: { handoffFile: string }) => {
    try {
      const configDir = (deps.configDir ?? getElanousConfigDir)();
      const consumeHandoff = async (path: string) => {
        const approved = readApprovedHandoff(path);
        const connected = await connectApprovedMemberSession({ ...approved, nexusUrl: 'https://api.elanous.ai',
          configDir, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
        if (connected.relayKeyUnavailable) io.error('회원 연결은 완료했지만 relay 키가 없습니다. 나중에 elanous member key issue로 다시 발급해 주세요.');
      };
      if (options.handoffFile) await consumeHandoff(options.handoffFile);
      else await startApprovedMemberConnect({ configDir, consumeHandoff, output: line => io.log(line),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.now ? { now: deps.now } : {}) });
      io.log('회원 앱 세션을 연결했습니다.');
      exit(0);
    } catch (error) { io.error(memberConnectDiagnostic(error)); exit(1); }
  });
}
