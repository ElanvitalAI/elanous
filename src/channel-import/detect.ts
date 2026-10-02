// EN13 — 셋업이 «이미 쓰던» 텔레그램·디스코드 설정을 찾아 온다(대표 10-01).
// 출처: OpenClaw(~/.openclaw/openclaw.json · tokenFile) · Hermes(~/.hermes/.env) · 이전 엘라누스(~/.monad/config.json).
// ⛔ 토큰 값은 이 모듈 밖으로 «문자열»로 나가지 않는다 — `BotToken` 이 감싸고, 문자열화·JSON·inspect 는 전부 가린다.
//    값이 필요한 곳(저장·연결 확인)만 `reveal()` 을 부른다. 미리보기는 «있음 · 끝 4자리 가림»만 낸다.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ImportPlatform = 'telegram' | 'discord';
export type ImportSource = 'openclaw' | 'hermes' | 'elanous-legacy';

const MASK = '있음 · 끝 4자리 가림';

/** A bot token that never prints itself. */
export class BotToken {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  /** Same-token check without exposing either value. */
  fingerprint(): string { return createHash('sha256').update(this.#value).digest('hex').slice(0, 8); }
  toString(): string { return MASK; }
  toJSON(): string { return MASK; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return MASK; }
}

export interface ImportCandidate {
  platform: ImportPlatform;
  source: ImportSource;
  /** `~`-relative file the value came from. */
  file: string;
  token: BotToken;
  allowedUsers: string[];
  /** Allowlist entries we could not use (not a numeric Telegram id, etc.). */
  droppedUsers: number;
}

export const SOURCE_LABEL: Record<ImportSource, string> = {
  openclaw: 'OpenClaw', hermes: 'Hermes', 'elanous-legacy': '이전 엘라누스(~/.monad)',
};

function tilde(path: string, home: string): string { return path.startsWith(home) ? `~${path.slice(home.length)}` : path; }
function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

/** JSON with comments and trailing commas (openclaw.json is JSON5-ish). Strings are kept intact. */
export function parseLooseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') { out += raw[++i] ?? ''; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && raw[i + 1] === '/') { while (i < raw.length && raw[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && raw[i + 1] === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** `KEY=value` lines (quotes and `export ` allowed, `#` comments ignored). */
export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]!] = value.trim();
  }
  return out;
}

/** Telegram allowlists must be numeric user ids; `telegram:123` / `tg:123` prefixes are accepted. */
export function normalizeUsers(platform: ImportPlatform, raw: unknown): { users: string[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const users: string[] = [];
  let dropped = 0;
  for (const entry of list) {
    const value = String(entry).trim().replace(/^(?:telegram|tg|discord|user):/i, '');
    if (!value || value === '*') { if (value === '*') dropped++; continue; }
    const ok = platform === 'telegram' ? /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 : /^\d{5,}$/.test(value);
    if (ok && !users.includes(value)) users.push(value); else if (!ok) dropped++;
  }
  return { users, dropped };
}

function readRegularFile(path: string): string | null {
  try { return lstatSync(path).isFile() ? readFileSync(path, 'utf8').trim() || null : null; } catch { return null; }
}

function candidate(platform: ImportPlatform, source: ImportSource, file: string, token: string | null, users: unknown): ImportCandidate | null {
  if (!token) return null;
  const { users: allowedUsers, dropped } = normalizeUsers(platform, users);
  return { platform, source, file, token: new BotToken(token), allowedUsers, droppedUsers: dropped };
}

function fromOpenClaw(home: string): ImportCandidate[] {
  const path = join(home, '.openclaw', 'openclaw.json');
  if (!existsSync(path)) return [];
  const cfg = obj(parseLooseJson(readFileSync(path, 'utf8')));
  const channels = obj(cfg?.channels);
  const file = tilde(path, home);
  const out: ImportCandidate[] = [];
  const telegram = obj(channels?.telegram);
  if (telegram) {
    const firstAccount = obj(Object.values(obj(telegram.accounts) ?? {})[0]);
    const token = text(telegram.botToken) ?? (text(telegram.tokenFile) ? readRegularFile(text(telegram.tokenFile)!.replace(/^~(?=\/)/, home)) : null)
      ?? text(firstAccount?.botToken);
    const c = candidate('telegram', 'openclaw', file, token, telegram.allowFrom ?? firstAccount?.allowFrom);
    if (c) out.push(c);
  }
  const discord = obj(channels?.discord);
  if (discord) {
    const firstAccount = obj(Object.values(obj(discord.accounts) ?? {})[0]);
    const c = candidate('discord', 'openclaw', file, text(discord.token) ?? text(firstAccount?.token), discord.allowFrom ?? obj(discord.dm)?.allowFrom);
    if (c) out.push(c);
  }
  return out;
}

function fromHermes(home: string): ImportCandidate[] {
  const path = join(home, '.hermes', '.env');
  if (!existsSync(path)) return [];
  const env = parseDotEnv(readFileSync(path, 'utf8'));
  const file = tilde(path, home);
  return [
    candidate('telegram', 'hermes', file, text(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_ALLOWED_USERS),
    candidate('discord', 'hermes', file, text(env.DISCORD_BOT_TOKEN), env.DISCORD_ALLOWED_USERS),
  ].filter((c): c is ImportCandidate => c !== null);
}

function fromElanousLegacy(home: string): ImportCandidate[] {
  const path = join(home, '.monad', 'config.json');
  if (!existsSync(path)) return [];
  const cfg = obj(parseLooseJson(readFileSync(path, 'utf8')));
  const file = tilde(path, home);
  return (['telegram', 'discord'] as const)
    .map((platform) => candidate(platform, 'elanous-legacy', file, text(obj(cfg?.[platform])?.botToken), obj(cfg?.[platform])?.allowedUsers))
    .filter((c): c is ImportCandidate => c !== null);
}

export interface DetectResult { candidates: ImportCandidate[]; unreadable: { file: string; reason: string }[] }

/** Look in every known place; a broken file is reported by name (never by content) and the rest still count. */
export function detectChannelImports(home = homedir()): DetectResult {
  const candidates: ImportCandidate[] = [];
  const unreadable: DetectResult['unreadable'] = [];
  const readers: [string, (h: string) => ImportCandidate[]][] = [
    [join(home, '.monad', 'config.json'), fromElanousLegacy],
    [join(home, '.openclaw', 'openclaw.json'), fromOpenClaw],
    [join(home, '.hermes', '.env'), fromHermes],
  ];
  for (const [path, read] of readers) {
    try { candidates.push(...read(home)); }
    catch (error) {
      // JSON parse errors can quote the offending text — keep only the error class.
      unreadable.push({ file: tilde(path, home), reason: error instanceof SyntaxError ? '형식을 읽지 못했습니다' : '읽지 못했습니다' });
    }
  }
  return { candidates, unreadable };
}

/** One per platform: the first source in priority order; the rest are named as «다른 토큰도 있음». */
export function pickPerPlatform(candidates: readonly ImportCandidate[]): { chosen: ImportCandidate[]; others: ImportCandidate[] } {
  const chosen: ImportCandidate[] = [];
  const others: ImportCandidate[] = [];
  for (const c of candidates) {
    const first = chosen.find((x) => x.platform === c.platform);
    if (!first) chosen.push(c);
    else if (first.token.fingerprint() !== c.token.fingerprint()) others.push(c);
    else for (const user of c.allowedUsers) if (!first.allowedUsers.includes(user)) first.allowedUsers.push(user);
  }
  return { chosen, others };
}

export function previewLine(c: ImportCandidate): string {
  const name = c.platform === 'telegram' ? '텔레그램' : '디스코드';
  const users = c.allowedUsers.length ? `허용 사용자 ${c.allowedUsers.length}명` : '허용 사용자 없음(나중에 정해야 합니다)';
  const dropped = c.droppedUsers ? ` · 쓸 수 없는 항목 ${c.droppedUsers}개 제외` : '';
  return `${name} ← ${SOURCE_LABEL[c.source]} (${c.file}): 토큰 ${MASK} · ${users}${dropped}`;
}
