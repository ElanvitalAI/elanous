// ELS-RUNTIME-ADAPTERS (대표 11-26 «els 는 어댑터 기반») — the one contract every agent runtime in an els pane plugs into
// (design note: 내부 문서 `ELS-RUNTIME-ADAPTERS`). An adapter knows how to recognise its runtime (detect), how to read
// its screen (status · the screen rules), and which input bytes do what (insertAttachment · insertText · interrupt) —
// as InputOps the caller sends through the els control door. An adapter NEVER submits: no op it returns ends with Enter.

export type RuntimeId = 'eln' | 'claude' | 'codex' | 'grok' | 'shell';
export type AgentStatus = 'idle' | 'busy' | 'asking' | 'exited';
/** One input step: a bracketed paste of text (the pane's own paste path), or raw key bytes. */
export type InputOp = { readonly kind: 'paste'; readonly text: string } | { readonly kind: 'keys'; readonly bytes: string };

export interface PaneRef {
  readonly pane: string;
  /** The runtime els recorded for the pane (`els ls` kind: eln · codex · claude · grok · shell · other). */
  readonly kind?: string;
  readonly cmdline?: readonly string[];
  readonly title?: string;
  readonly screen?: string;
}

/** The screen facts a runtime shows (pane-status.ts reads them; regexes live with their runtime, nowhere else). */
export interface ScreenRules {
  /** Any line matching one of these = a turn is running. */
  readonly busy: readonly RegExp[];
  /** Regex source of the prompt row's head (eln «❯», Claude Code «│ >»); the row regex is built from the heads. */
  readonly promptHead?: string;
  /** The running-tool row: group 1 = tool name, group 2 = elapsed. */
  readonly tool?: RegExp;
  /** The approval / question prompt is up (waiting for the person). Bottom of the screen. */
  readonly asking?: (screen: string) => boolean;
}

export interface RuntimeCapabilities {
  /** Files can be handed to it (as @-mentions or paths in its input line). */
  readonly attach: boolean;
  /** Its input line understands «@<path>». */
  readonly mention: boolean;
  /** An image path given to it reaches the model as an image. */
  readonly images: boolean;
  /** It takes a turn from its input line + Enter (els never presses that Enter for an attach). */
  readonly sendTurn: boolean;
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  /** The runtime word shown in the agents panel; undefined = say nothing (eln is everyone's runtime; a shell is no agent). */
  readonly label?: string;
  /** Does this pane run this runtime? (the command line's executable; title/screen only as a hint). */
  readonly detect: (pane: { readonly cmdline?: readonly string[]; readonly title?: string; readonly screen?: string }) => boolean;
  readonly screen: ScreenRules;
  readonly status: (screen: string | undefined, exited?: boolean) => AgentStatus;
  readonly insertAttachment: (pane: PaneRef, files: readonly string[]) => InputOp[];
  readonly insertText: (pane: PaneRef, text: string) => InputOp[];
  readonly interrupt: (pane: PaneRef) => InputOp[];
  readonly capabilities: RuntimeCapabilities;
}
