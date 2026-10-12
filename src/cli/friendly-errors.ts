import { detectLocale, type Locale } from '../expression/locale.js';
import { classifyError } from '../session-runtime/retry-policy.js';

export type FriendlyErrorCode =
  | 'credential-missing'
  | 'provider-unknown'
  | 'model-unavailable'
  | 'network'
  | 'quota'
  | 'context-too-long'
  | 'config-broken'
  | 'daemon-down'
  | 'permission'
  | 'unknown-command';

export interface FriendlyMessage {
  what: string;
  why: string;
  next: string;
}

export type FriendlyLanguage = 'ko' | 'en';

export const FRIENDLY_ERRORS: Readonly<Record<FriendlyErrorCode, Readonly<Record<FriendlyLanguage, FriendlyMessage>>>> = {
  'credential-missing': {
    ko: { what: '모델에 접속할 자격이 없습니다', why: '이 provider 에 로그인하지 않았거나 키가 없습니다', next: 'elanous login' },
    en: { what: 'No credentials for this model provider', why: 'You have not signed in or set a key', next: 'elanous login' },
  },
  'provider-unknown': {
    ko: { what: '설정된 provider 를 모릅니다', why: 'llm.provider 값이 지원 목록에 없습니다', next: 'elanous config get llm.provider' },
    en: { what: 'Unknown model provider', why: 'llm.provider is not a supported name', next: 'elanous config get llm.provider' },
  },
  'model-unavailable': {
    ko: { what: '이 모델을 쓸 수 없습니다', why: 'provider 와 모델이 맞지 않거나 모델이 없습니다', next: 'elanous config get llm.model' },
    en: { what: 'This model is not available', why: 'The provider and model do not match, or the model does not exist', next: 'elanous config get llm.model' },
  },
  network: {
    ko: { what: '서버에 연결하지 못했습니다', why: '네트워크가 끊겼거나 서버가 응답하지 않습니다', next: 'elanous doctor' },
    en: { what: 'Could not reach the server', why: 'The network is down or the server did not answer', next: 'elanous doctor' },
  },
  quota: {
    ko: { what: '사용 한도에 걸렸습니다', why: '이 계정의 할당량을 다 썼거나 요청이 너무 잦습니다', next: 'elanous usage' },
    en: { what: 'Usage limit reached', why: 'The account quota is used up or requests are too frequent', next: 'elanous usage' },
  },
  'context-too-long': {
    ko: { what: '입력이 너무 깁니다', why: '모델이 한 번에 읽는 양을 넘었습니다', next: 'elanous ask "<더 짧은 질문>"' },
    en: { what: 'The input is too long', why: 'It exceeds what the model reads at once', next: 'elanous ask "<shorter question>"' },
  },
  'config-broken': {
    ko: { what: '설정 파일을 읽지 못했습니다', why: 'config 파일의 JSON 이 깨졌습니다', next: 'elanous doctor --fix' },
    en: { what: 'Could not read the config file', why: 'The config JSON is malformed', next: 'elanous doctor --fix' },
  },
  'daemon-down': {
    ko: { what: '엘라누스 데몬이 떠 있지 않습니다', why: '백그라운드 서비스가 꺼져 있습니다', next: 'elanous nexus' },
    en: { what: 'The elanous daemon is not running', why: 'The background service is stopped', next: 'elanous nexus' },
  },
  permission: {
    ko: { what: '파일에 접근할 권한이 없습니다', why: '이 사용자로 그 경로를 읽거나 쓸 수 없습니다', next: 'elanous doctor' },
    en: { what: 'Permission denied', why: 'This user cannot read or write that path', next: 'elanous doctor' },
  },
  'unknown-command': {
    ko: { what: '모르는 명령입니다', why: '명령 이름이 틀렸거나 이 판에 없습니다', next: 'elanous --help' },
    en: { what: 'Unknown command', why: 'The name is misspelled or not in this version', next: 'elanous --help' },
  },
};

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

function errnoOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/** Maps a thrown value to a friendly-error code by its wording and by the
 *  retry-policy category. Returns null when nothing matches. */
export function classifyFriendlyError(err: unknown): FriendlyErrorCode | null {
  const msg = messageOf(err);
  const errno = errnoOf(err);

  if (/provider-model compatibility/i.test(msg)) return 'model-unavailable';
  if (/\bunknown provider:/i.test(msg)) return 'provider-unknown';
  if (/\bunavailable:\s+(set|run|configure)\b/i.test(msg)) return 'credential-missing';
  if (/the elanous daemon is not running/i.test(msg)) return 'daemon-down';
  if (/unknown command '/i.test(msg)) return 'unknown-command';
  if (/input exceeds the \d+-token context budget/i.test(msg)) return 'context-too-long';
  if (
    /Unexpected token .*JSON|JSON Parse error|is not valid JSON|JSON at position/i.test(msg) ||
    (err instanceof Error && err.name === 'SyntaxError' && /json/i.test(msg))
  ) return 'config-broken';
  if (errno === 'EACCES' || errno === 'EPERM' || /\b(EACCES|EPERM)\b/.test(msg)) return 'permission';

  switch (classifyError(err)) {
    case 'network-transient': return 'network';
    case 'quota-exceeded':
    case 'rate-limit': return 'quota';
    case 'context-window-exceeded': return 'context-too-long';
    case 'provider-unavailable': return 'credential-missing';
    default: return null;
  }
}

/** Renders one language only (ko, otherwise en). The last line is the one command to run. */
export function formatFriendlyError(code: FriendlyErrorCode, locale: Locale = detectLocale()): string {
  const language: FriendlyLanguage = locale === 'ko' ? 'ko' : 'en';
  const { what, why, next } = FRIENDLY_ERRORS[code][language];
  return `❌ ${what}\n  ↳ ${why}\n  ${next}`;
}
