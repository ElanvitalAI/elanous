// `elanous --name <name>` — 맨 `elanous`(대시보드 TUI)가 자기 PTY manifest 행(`tui:<pid>`)에
// 별명을 달고 뜬다. 그러면 `elanous pty list` 에 그 이름이 보이고 `pty snapshot <name>` ·
// `pty text <name> …` 가 별명으로 해석된다(ref 해석은 이미 nickname 을 받는다).
//
// ⭐ 루트 «실행» 플래그다 — `--resume`·`--debug` 와 같은 규칙으로 Commander «전»에 걷어낸다.
// ⛔ 하위 명령 «뒤»의 `--name`(`elanous pty list --name x` · `elanous --debug session new --name x`)은 건드리지 않는다 — 그 명령이 `--name` 을
//    자기 옵션으로 가질 수 있다(가로채면 조용히 그 옵션을 먹는다).

import { ROOT_FLAGS_TAKING_VALUE } from './remote-resolve.js';

export interface DashboardNameFlag {
  /** 걷어낸 뒤의 인자 — Commander·대시보드 필터로 넘긴다. */
  readonly args: string[];
  /** 준 이름(앞뒤 공백 제거). 플래그가 없으면 undefined. */
  readonly name?: string;
  /** 값이 없거나 빈 이름이면 사람에게 낼 오류 문면. */
  readonly error?: string;
}

/** 루트 «선행 플래그 구간»에서 값을 받는 플래그 — 그 값 토큰은 하위 명령이 아니다. */
const LEADING_VALUE_FLAGS = new Set([...ROOT_FLAGS_TAKING_VALUE, '--resume']);

/** 루트 선행 플래그 구간 안의 `--name` 위치. 하위 명령(맨 위치 인자)이나 `--` 를 만나면 멈춘다 —
 *  `elanous --debug session new --name x` 의 `--name` 은 그 하위 명령의 것이다(리뷰 must-fix). */
function leadingNameIndex(rawArgs: readonly string[]): number {
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]!;
    if (arg === '--' || !arg.startsWith('-')) return -1;
    if (arg === '--name' || arg.startsWith('--name=')) return i;
    if (LEADING_VALUE_FLAGS.has(arg)) i += 1;
  }
  return -1;
}

export function readDashboardNameFlag(rawArgs: readonly string[]): DashboardNameFlag {
  const idx = leadingNameIndex(rawArgs);
  if (idx < 0) return { args: [...rawArgs] };
  const flag = rawArgs[idx]!;
  const inline = flag.startsWith('--name=');
  const value = inline ? flag.slice('--name='.length) : rawArgs[idx + 1];
  const args = rawArgs.filter((_, i) => i !== idx && (inline || i !== idx + 1));
  if (value === undefined || (!inline && value.startsWith('-'))) {
    return { args: rawArgs.filter((_, i) => i !== idx), error: 'elanous: --name needs a value (e.g. elanous --name op)' };
  }
  const name = value.trim();
  if (!name) return { args, error: 'elanous: --name must not be empty' };
  return { args, name };
}
