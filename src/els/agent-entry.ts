// ELS-PANE-LABEL-MODEL-FIRST (대표 11-25 «거의 다 eln 이라 eln 표시는 정보가 없다 · 주 모델이 중요 · eln 이 아니면 그래도 읽혀야 한다»).
// S: the agents panel said «eln · OP» under every seat — the runtime nearly everyone shares, and the space the group already names.
// C: what tells seats apart now is the MODEL (terra · grok · opus · glm-5.3), the cell a hand holds, the space it is lent to,
//    the host it runs on, and whether it is alive — and a non-eln runtime (codex CLI, Claude Code) must still read plainly.
// A: one pure formatter for an agents-panel entry — line 1 «<mark> <SEAT> <model>», line 2 (dim, when the width allows)
//    «@<space lent to> · <runtime when not eln> · ⇄<host> · <age> · <cell>». The literal «eln» is never drawn.
// 세 얼굴: 관측 = `els ls` (model from the eln's own meta report, or the --model/-m on the live foreground command line; none
//          otherwise — never guessed) · 판단 근거 = the hand title format of #40117 (seat · space · cell · model) ·
//          수복과 인계 = a missing fact drops its part; the line never invents one.

/** Short family label of a model id: gpt-6.1-terra → terra · gpt-6.1 → gpt-6.1 · grok-4.1-fast → grok · claude-opus-5-5 → opus · z-ai/glm-5.3 → glm-5.3. */
export function modelLabel(model: string | undefined): string | undefined {
  const id = (model ?? '').trim().toLowerCase().split('/').pop()!.replace(/\[.*\]$/, '');
  if (!id) return undefined;
  const claude = /\b(opus|sonnet|haiku|fable)\b/.exec(id.replace(/-/g, ' '));
  if (id.includes('claude') || claude) return claude ? claude[1] : 'claude';
  if (id.startsWith('grok')) return 'grok';
  const gpt = /^(gpt-[0-9.]+)(?:-([a-z]+))?/.exec(id);
  if (gpt) return gpt[2] && !['mini', 'nano', 'pro', 'codex', 'turbo', 'preview', 'latest'].includes(gpt[2]) ? gpt[2] : gpt[2] ? `${gpt[1]}-${gpt[2]}` : gpt[1];
  const versioned = /^([a-z]+)-?([0-9][0-9.]*)/.exec(id);
  if (versioned) return `${versioned[1]}-${versioned[2]}`.slice(0, 14);
  return id.slice(0, 14);
}

/** The model named on a live command line (`--model X` · `--model=X` · `-m X`); undefined when the command names none. */
export function commandModel(command: readonly string[] | undefined): string | undefined {
  const args = command ?? [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg.startsWith('--model=')) return arg.slice(8) || undefined;
    if ((arg === '--model' || arg === '-m') && args[at + 1] && !args[at + 1]!.startsWith('-')) return args[at + 1];
  }
  return undefined;
}

/** Runtime word for a non-eln agent; eln (and an unknown pane) says nothing. */
export function runtimeLabel(agent: string | undefined): string | undefined {
  return agent === 'codex' ? 'codex-cli' : agent === 'claude' ? 'claude-code' : agent === 'grok' ? 'grok-cli' : undefined;
}

/** The hand title of #40117 read back: «<ID> · <SPACE> · <cell> · <model>» or «<ID> · idle · <model>». */
export function parseHandTitle(title: string): { readonly seat: string; readonly space?: string; readonly cell?: string } | undefined {
  const parts = title.split(' · ').map((part) => part.trim());
  if (parts.length < 2 || !/^[A-Z][A-Z0-9]*-H-[A-Z0-9_-]+$/.test(parts[0]!)) return undefined;
  if (parts[1] === 'idle') return { seat: parts[0]! };
  return parts.length >= 4 ? { seat: parts[0]!, space: parts[1]!, cell: parts[2]! } : parts.length === 3 ? { seat: parts[0]!, cell: parts[1]! } : { seat: parts[0]! };
}

/** «now» under 10 s, then 45s · 3m · 2h · 4d. */
export function ageLabel(lastEventAtMs: number | undefined, nowMs: number): string | undefined {
  if (!lastEventAtMs || !Number.isFinite(lastEventAtMs)) return undefined;
  const s = Math.max(0, Math.floor((nowMs - lastEventAtMs) / 1000));
  return s < 10 ? 'now' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

const cut = (text: string, max: number): string => { const chars = [...text]; return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`; };

export interface AgentEntryInput {
  /** The seat id (or the tab's own name for a pane that is no seat). */
  readonly name: string;
  readonly title: string;
  readonly agent?: string;
  readonly model?: string;
  readonly command?: readonly string[];
  /** The space whose group the entry is drawn in. */
  readonly groupSpace: string;
  readonly remote?: string;
  readonly lastEventAtMs?: number;
}

/** ELS-REMOTE-SEAT-MARK: «🌐» (2 cells) after a remote seat id; «⇄» when ELS_ASCII=1 or the terminal draws no wide emoji. */
export function remoteMark(env: Record<string, string | undefined> = process.env): string {
  return env.ELS_ASCII === '1' || env.ELS_NO_EMOJI === '1' || env.TERM === 'linux' ? '⇄' : '🌐';
}

/** Line 1 tail after the mark, and the dim line 2 (empty when there is nothing to say). */
export function agentEntry(input: AgentEntryInput, nowMs: number): { readonly head: string; readonly detail: string } {
  const hand = parseHandTitle(input.title);
  const model = modelLabel(input.model ?? commandModel(input.command));
  // ELS-REMOTE-SEAT-MARK (대표 11-25 «not too loud»): a seat of another host carries a quiet single-width «⇄» right after its id.
  const head = `${hand?.seat ?? input.name}${input.remote ? ` ${remoteMark()}` : ''}${model ? ` ${model}` : ''}`;
  const lent = hand?.space && hand.space.toUpperCase() !== input.groupSpace.toUpperCase() ? `@${hand.space}` : undefined;
  // the cell goes last: a narrow sidebar cuts it, never the short facts before it.
  const parts = [lent, runtimeLabel(input.agent), input.remote ? `⇄${input.remote}` : undefined, ageLabel(input.lastEventAtMs, nowMs), hand?.cell ? cut(hand.cell, 18) : undefined];
  return { head, detail: parts.filter((part): part is string => !!part).join(' · ') };
}
