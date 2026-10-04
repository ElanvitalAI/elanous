// Final-screen evidence is independent of the controller's "done" declaration.
export type PtyDriveVerdict =
  | { readonly kind: 'done-but-failed'; readonly reason: string; readonly evidence: null }
  | { readonly kind: 'success'; readonly reason: string; readonly evidence: string }
  | { readonly kind: 'success-unverified'; readonly reason: string; readonly evidence: null };

export interface FinalPtyEvidence {
  readonly screen: string;
  readonly inputHistory: readonly string[];
  readonly exitCode: number | null;
  /** A separately verified mission artifact; tool-history failures are not final-answer failures. */
  readonly artifactEvidence?: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const FAILURE = /(?:\bcommand not found\b|\bnot recognized as (?:an internal or external )?command\b|\bno such file or directory\b|\b(?:error|fatal|exception)\s*:|\berror TS\d+\b|\b(?:build failed|tests? failed|test suite failed|failed to|compilation failed|permission denied)\b|(?:^|\s)[1-9]\d*\s+fail(?:ed|ing|ures?)?\b|\b(?:exit(?:ed)? (?:with )?(?:code |status )?)[1-9]\d*\b|\bnpm ERR!\b|^\s*(?:FAIL\b|✗|❌))/i;
const SUCCESS = /(?:\b[1-9]\d*\s+(?:pass|passed)\b|\btests?:\s*[1-9]\d*\s+passed\b|\bbuild successful\b|\b(?:successfully|succeeded)\b|\bGOAL-COMPLETE\b)/i;

/** Failure wins over success; an exit code of zero is not itself proof of the goal. */
export function verdictForFinalPtyScreen({ screen, inputHistory, exitCode, artifactEvidence = false }: FinalPtyEvidence): PtyDriveVerdict {
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
  const toolNoMatch = (line: string) =>
    /\b(?:rg|grep|diff)\b.*\bexit(?:ed)?\s*(?:with\s*)?(?:code\s*)?1\b|\bexit(?:ed)?\s*(?:with\s*)?(?:code\s*)?1\b.*\b(?:rg|grep|diff)\b/i.test(line)
    && !/(?:\b(?:error|fatal|exception)\s*:|\b(?:build failed|tests? failed|failed to|permission denied|command not found)\b)/i.test(line);
  // Codex renders tool status as «• Failed (exit 1) …». It is not the agent's final answer.
  // For artifact-backed missions, consider only answer text following the last tool block.
  const lastTool = artifactEvidence ? lines.reduce((index, line, i) => /^•\s+(?:Ran|Failed|Running|Worked)\b/i.test(line) ? i : index, -1) : -1;
  const answer = lastTool < 0 ? lines : lines.slice(lastTool + 1).filter((line) => !/^[└│]/.test(line));
  const failure = (artifactEvidence ? answer : lines).find((line) => FAILURE.test(line) && !toolNoMatch(line));
  if (failure) return { kind: 'done-but-failed', reason: failure, evidence: null };
  const evidence = lines.find((line) => SUCCESS.test(line) && !/\b0\s+(?:pass|passed)\b/i.test(line));
  if (evidence) return { kind: 'success', reason: 'final PTY screen has success evidence', evidence };
  return { kind: 'success-unverified', reason: 'final PTY screen has no success evidence', evidence: null };
}
