// Final-screen evidence is independent of the controller's "done" declaration.
export type PtyDriveVerdict =
  | { readonly kind: 'done-but-failed'; readonly reason: string; readonly evidence: null }
  | { readonly kind: 'success'; readonly reason: string; readonly evidence: string }
  | { readonly kind: 'success-unverified'; readonly reason: string; readonly evidence: null };

export interface FinalPtyEvidence {
  readonly screen: string;
  readonly inputHistory: readonly string[];
  readonly exitCode: number | null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const FAILURE = /(?:\bcommand not found\b|\bnot recognized as (?:an internal or external )?command\b|\bno such file or directory\b|\b(?:error|fatal|exception)\s*:|\berror TS\d+\b|\b(?:build failed|tests? failed|test suite failed|failed to|compilation failed|permission denied)\b|(?:^|\s)[1-9]\d*\s+fail(?:ed|ing|ures?)?\b|\b(?:exit(?:ed)? (?:with )?(?:code |status )?)[1-9]\d*\b|\bnpm ERR!\b|^\s*(?:FAIL\b|✗|❌))/i;
const SUCCESS = /(?:\b[1-9]\d*\s+(?:pass|passed)\b|\btests?:\s*[1-9]\d*\s+passed\b|\bbuild successful\b|\b(?:successfully|succeeded)\b|\bGOAL-COMPLETE\b)/i;

/** Failure wins over success; an exit code of zero is not itself proof of the goal. */
export function verdictForFinalPtyScreen({ screen, inputHistory, exitCode }: FinalPtyEvidence): PtyDriveVerdict {
  if (exitCode !== null && exitCode !== 0) {
    return { kind: 'done-but-failed', reason: `child exit code ${exitCode}`, evidence: null };
  }
  // The PTY may echo commands (including fabricated success markers). Only child output is evidence.
  const inputs = new Set(inputHistory.flatMap((input) => input.replace(/\r/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)));
  // An echo/printf command prints its operand; that output is not independent proof of anything
  // (`echo "7 pass"` must not count as passing tests — review round 2).
  const echoedLiterals = new Set([...inputs].flatMap((input) => {
    const match = /^(?:echo(?:\s+-[neE]+)?|printf)\s+(.+)$/i.exec(input);
    if (!match) return [];
    const operand = match[1]!.trim().replace(/^(['"])(.*)\1$/s, '$2').replace(/\\n$/, '').trim();
    return operand ? [operand] : [];
  }));
  const lines = screen.replace(ANSI, '').replace(/\r/g, '\n').split('\n')
    .map((line) => line.trim()).filter((line) => line && !inputs.has(line) && !echoedLiterals.has(line) && ![...inputs].some((input) => line.endsWith(`$ ${input}`) || line.endsWith(`> ${input}`)));
  const failure = lines.find((line) => FAILURE.test(line));
  if (failure) return { kind: 'done-but-failed', reason: failure, evidence: null };
  const evidence = lines.find((line) => SUCCESS.test(line) && !/\b0\s+(?:pass|passed)\b/i.test(line));
  if (evidence) return { kind: 'success', reason: 'final PTY screen has success evidence', evidence };
  return { kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null };
}
