// TUI-SLASH-DECIDE-NOW C · 2026-10-07 — `/help` was one alphabetical block of ~70 commands (F3 · F14:
// `/model` sat three PgUps deep). Commands are now shown in task order: «시작», then the seven public
// verbs (내부 문서 `MAP-value-props-to-features` — same words), then «그 밖».
//
// The table maps a canonical slash name to its group. A registered command that is not in the table
// falls into «그 밖» automatically — grouping never hides a command (registration and maturity decide that).

export const HELP_START_GROUP = '시작';
export const HELP_OTHER_GROUP = '그 밖';

/** The seven public verbs, in the order the public map uses them. */
export const HELP_VERB_GROUPS = [
  '지켜보기',
  '조사하기',
  '판단하기',
  '만들기',
  '실행하기',
  '확인하기',
  '기억하기',
] as const;

/** Render order: start, the seven verbs, then everything else. */
export const HELP_GROUP_ORDER: readonly string[] = [HELP_START_GROUP, ...HELP_VERB_GROUPS, HELP_OTHER_GROUP];

const GROUP_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  [HELP_START_GROUP]: ['help', 'status', 'model', 'clear', 'new', 'resume'],
  지켜보기: ['now', 'loops', 'mission', 'log', 'term', 'surface', 'conv', 'capture', 'telegram', 'remaining', 'debug'],
  조사하기: ['research', 'prompt', 'context'],
  판단하기: ['decide', 'plan', 'wish', 'directive'],
  만들기: ['harness', 'ad', 'export'],
  실행하기: ['run-skill', 'claude', 'codex', 'gemini', 'acp', 'agent-room', 'showroom', 'relay', 'lane', 'reply', 'handoff', 'inject', 'control', 'qc', 'default'],
  확인하기: ['delta', 'design', 'rewind'],
  기억하기: ['memory', 'session', 'fork', 'resume-turn', 'history', 'persona'],
};

/** Canonical slash name → group. */
export const HELP_GROUP_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(GROUP_MEMBERS).flatMap(([group, names]) => names.map((name) => [name, group] as const)),
);

/** Group for a canonical slash name; anything unmapped is «그 밖». */
export function helpGroupFor(name: string): string {
  return HELP_GROUP_BY_NAME.get(name) ?? HELP_OTHER_GROUP;
}
