// Live «공개 캡처» 가림(🅢 09-28 10:3x — 공개 사진에 내부 계정 이름·크레딧 잔액·«API 환산 $» 가 실렸다).
// 녹화·스크린샷 전에 켠다: 계정 이름 → `account-1/2/3`(처음 본 순서) · 크레딧·USD 값 → `•••` · `/Users/<이름>` → `~`.
// ⛔ 화면에 그리기 «전»의 줄(LogRow)을 바꾼다 — 판단 문장·그래프 노드·띠가 모두 같은 줄에서 나오므로 한 곳에서 가리면 전부 가려진다.
// ⛔ 원본 줄은 바꾸지 않는다(새 객체) — 토글을 끄면 그대로 돌아온다.

import type { LogRow } from '@/nexus/client';

const ACCOUNT_CATEGORIES = /^(oauth\.|harness\.decision|llm\.router)/;

/** 계정 이름을 모은다 — `oauth.codex-account` 줄(from·to·name·account·usage[].name) ⊕ 판단·라우터 줄의 `account` 칸 ⊕ 문장 속 «계정 <이름>».
 *  (🅞 09-29 05:31: PTY 벽 의도 띠가 oauth 줄 없이 판단 줄만 받아 «계정 default 유지 · 잔: default 7%» 가 그대로 찍혔다.) */
export function accountNames(rows: readonly LogRow[]): string[] {
  const names: string[] = [];
  const addName = (v: unknown) => { if (typeof v === 'string' && v.trim() && !names.includes(v.trim())) names.push(v.trim()); };
  for (const row of rows) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    if (row.category.startsWith('oauth.')) {
      for (const k of ['from', 'to', 'name', 'account']) addName(d[k]);
      if (Array.isArray(d.usage)) for (const u of d.usage) addName((u as { name?: unknown } | null)?.name);
      continue;
    }
    if (!ACCOUNT_CATEGORIES.test(row.category)) continue;
    addName(d.account);
    for (const k of ['what', 'why', 'reason']) {
      const v = d[k];
      if (typeof v === 'string') for (const m of v.matchAll(/계정\s+([A-Za-z0-9][\w.-]*)/g)) addName(m[1]);
    }
  }
  return names;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function makePublicMasker(names: readonly string[]): (text: string, accountScope: boolean) => string {
  const alias = new Map(names.map((n, i) => [n, `account-${i + 1}`]));
  const accountRe = names.length ? new RegExp(`(^|[^\\w-])(${names.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`, 'g') : null;
  // 호스트 이름(Pod 풀 기계 `node-b` · tailnet 주소 `*.ts.net`)도 공개 사진에 싣지 않는다 — 처음 본 순서로 `remote-N`.
  const hosts = new Map<string, string>();
  const hostAlias = (name: string) => {
    const key = name.toLowerCase();
    if (!hosts.has(key)) hosts.set(key, `remote-${hosts.size + 1}`);
    const alias = hosts.get(key)!;
    return name === name.toUpperCase() ? alias.toUpperCase() : alias;
  };
  return (text, accountScope) => {
    let out = text
      .replace(/\b[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net\b/gi, 'tailnet-host')
      .replace(/\bmsb\d+\b/gi, (m) => hostAlias(m))
      // 이 기계(맥북) 약칭 — 카드·이슈 제목에 «mbp» 로 적힌다.
      .replace(/\bmbp\b/gi, (m) => (m === m.toUpperCase() ? 'LOCAL' : 'local'))
      .replace(/\/Users\/[^/\s"']+/g, '~')
      .replace(/(크레딧|credits?|💳)(\s*[:=]?\s*)[\d][\d,.]*/gi, '$1$2•••')
      .replace(/[\d][\d,.]*(\s*)(크레딧|credits?)/gi, '•••$1$2')
      .replace(/\$\s?[\d][\d,.]*/g, '$•••')
      // 잔량(«잔: default 7%» · «remaining 12%») — 계정 한도는 공개 사진에 싣지 않는다.
      .replace(/(잔량?|remaining|left)(\s*[:=]?\s*)(?:[A-Za-z0-9][\w.-]*\s+)?\d+(?:\.\d+)?\s?%/gi, '$1$2•••');
    if (accountScope && accountRe) out = out.replace(accountRe, (_m, pre: string, name: string) => `${pre}${alias.get(name) ?? 'account'}`);
    return out;
  };
}

function walk(value: unknown, mask: (s: string) => string): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, mask));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // 과금 환산 칸은 값을 없앤다(0 이 아니라 «없음» — 화면이 칸을 숨긴다).
      if (k === 'apiEquivalentUsd' || k === 'usd' || /credit(s|Balance)?$/i.test(k)) continue;
      out[k] = walk(v, mask);
    }
    return out;
  }
  return value;
}

/** 공개 캡처용 줄 — 새 배열. */
export function maskRowsForPublic(rows: readonly LogRow[]): LogRow[] {
  const mask = makePublicMasker(accountNames(rows));
  return rows.map((row) => {
    const scope = ACCOUNT_CATEGORIES.test(row.category);
    return { ...row, event: mask(row.event, false), data: row.data ? (walk(row.data, (s) => mask(s, scope)) as Record<string, unknown>) : row.data };
  });
}

/** 줄 밖의 값(서버 판단 사슬 · L4 원문 JSON)도 같은 규칙으로 가린다 — 계정 이름은 `names`(보통 `accountNames(창 줄)`)로. */
export function maskValueForPublic<T>(value: T, names: readonly string[]): T {
  const mask = makePublicMasker(names);
  return walk(value, (s) => mask(s, true)) as T;
}
