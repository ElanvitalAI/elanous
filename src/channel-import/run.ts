// EN13 — 감지 → 미리보기 → 동의 → 시크릿 저장 → 연결 확인(읽기 1회). 토큰 값은 화면·로그·채널 어디에도 안 나간다.
import { homedir } from 'node:os';
import { debug } from '../debug/log.js';
import { detectChannelImports, pickPerPlatform, previewLine, SOURCE_LABEL, type ImportCandidate, type ImportPlatform } from './detect.js';

export interface ChannelImportDeps {
  home?: string;
  out?: { log: (s: string) => void; error: (s: string) => void };
  /** Asks once; returns true for yes. Absent or non-interactive → no. */
  ask?: (question: string) => Promise<boolean>;
  yes?: boolean;
  /** Current token for that platform (to say «already the same»), or null. */
  currentToken?: (platform: ImportPlatform) => string | null | Promise<string | null>;
  store?: (platform: ImportPlatform, token: string, allowedUsers: string[] | undefined) => Promise<void>;
  probe?: (platform: ImportPlatform, token: string) => Promise<{ ok: boolean; botName?: string }>;
}

export interface ChannelImportOutcome {
  exitCode: number;
  imported: { platform: ImportPlatform; source: string; connected: boolean; botName?: string }[];
}

const NAME: Record<ImportPlatform, string> = { telegram: '텔레그램', discord: '디스코드' };

async function defaultStore(platform: ImportPlatform, token: string, allowedUsers: string[] | undefined): Promise<void> {
  const { storeChannelBotToken } = await import('../channel-bot-token.js');
  await storeChannelBotToken(platform, token, allowedUsers);
}

async function defaultProbe(platform: ImportPlatform, token: string): Promise<{ ok: boolean; botName?: string }> {
  const { probeChannelBotToken } = await import('../channel-bot-token.js');
  return probeChannelBotToken(platform, token);
}

async function defaultCurrentToken(platform: ImportPlatform): Promise<string | null> {
  try {
    const { resolveChannelBotToken } = await import('../channel-bot-token.js');
    const { getUserConfig } = await import('../user-config.js');
    return resolveChannelBotToken(platform, getUserConfig())?.token ?? null;
  } catch { return null; }
}

export async function runChannelImport(deps: ChannelImportDeps = {}): Promise<ChannelImportOutcome> {
  const out = deps.out ?? console;
  const home = deps.home ?? homedir();
  const { candidates, unreadable } = detectChannelImports(home);
  for (const u of unreadable) out.log(`· ${u.file}: ${u.reason} — 건너뜁니다`);
  const { chosen, others } = pickPerPlatform(candidates);
  debug.log('channel-import', 'detected', {
    sources: candidates.map((c) => `${c.source}:${c.platform}`), chosen: chosen.length, others: others.length, unreadable: unreadable.length,
  });
  if (!chosen.length) {
    out.log('가져올 텔레그램·디스코드 설정을 찾지 못했습니다(OpenClaw · Hermes · 이전 엘라누스). 직접 넣으려면: elanous nexus channel-bot setup telegram');
    return { exitCode: 0, imported: [] };
  }

  const current = deps.currentToken ?? defaultCurrentToken;
  const todo: ImportCandidate[] = [];
  out.log('이미 쓰던 채널 설정을 찾았습니다:');
  for (const c of chosen) {
    const existing = await current(c.platform);
    if (existing && existing === c.token.reveal()) { out.log(`· ${previewLine(c)} — 이미 같은 토큰을 쓰고 있습니다`); continue; }
    out.log(`· ${previewLine(c)}${existing ? ' — ⚠️ 지금 쓰는 토큰을 바꿉니다' : ''}`);
    todo.push(c);
  }
  for (const c of others) out.log(`  (${NAME[c.platform]} 토큰이 ${SOURCE_LABEL[c.source]}에도 있습니다 — 다른 토큰이라 위의 것만 가져옵니다)`);
  if (!todo.length) return { exitCode: 0, imported: [] };

  const question = `가져올까요? 토큰은 엘라누스 비밀 저장소에만 넣고 화면·로그에는 남기지 않습니다. [Y/n] `;
  const agreed = deps.yes || (deps.ask ? await deps.ask(question) : false);
  if (!agreed) {
    out.log(deps.ask || deps.yes ? '가져오지 않았습니다.' : '가져오려면: elanous nexus channel-bot import --yes');
    debug.log('channel-import', 'declined', { count: todo.length });
    return { exitCode: 0, imported: [] };
  }

  const store = deps.store ?? defaultStore;
  const probe = deps.probe ?? defaultProbe;
  const imported: ChannelImportOutcome['imported'] = [];
  let failed = 0;
  for (const c of todo) {
    try {
      await store(c.platform, c.token.reveal(), c.allowedUsers.length ? c.allowedUsers : undefined);
    } catch (error) {
      failed++;
      // Store errors are our own (lock, invalid ids) — print the class only, never the message, in case it carries input.
      const reason = error instanceof Error && error.message === 'invalid-allowed-users' ? '허용 사용자 형식이 맞지 않습니다' : '저장하지 못했습니다';
      out.error(`✗ ${NAME[c.platform]}: ${reason}`);
      debug.log('channel-import', 'store-failed', { platform: c.platform, source: c.source }, { level: 'warn' });
      continue;
    }
    const check = await probe(c.platform, c.token.reveal()).catch(() => ({ ok: false } as { ok: boolean; botName?: string }));
    imported.push({ platform: c.platform, source: c.source, connected: check.ok, ...(check.botName ? { botName: check.botName } : {}) });
    debug.log('channel-import', 'stored', { platform: c.platform, source: c.source, connected: check.ok });
    out.log(check.ok
      ? `✓ ${NAME[c.platform]}: 저장했고 연결을 확인했습니다 — @${check.botName}`
      : `△ ${NAME[c.platform]}: 저장했지만 연결 확인에 실패했습니다 — 토큰이 만료됐거나 네트워크 문제일 수 있습니다(다시 넣기: elanous nexus channel-bot setup ${c.platform})`);
  }
  if (imported.length) out.log('봇은 다음 넥서스 시작 때 켜집니다.');
  return { exitCode: failed ? 1 : 0, imported };
}

/** One line for onboarding — null when there is nothing to import. Never reveals a value. */
export function channelImportHint(home = homedir()): string | null {
  try {
    const { chosen } = pickPerPlatform(detectChannelImports(home).candidates);
    if (!chosen.length) return null;
    const what = chosen.map((c) => `${NAME[c.platform]}(${SOURCE_LABEL[c.source]})`).join(' · ');
    return `쓰던 채널 설정 찾음: ${what} — 가져오려면: elanous nexus channel-bot import`;
  } catch { return null; }
}
