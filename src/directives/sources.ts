// Public-build stand-in for src/directives/sources.ts (local-only source adapters, excluded by release/public-export.yaml).
// Only the shapes public modules type against live here; the public build has no utterance sources to scan.
export type DirectiveAgent = 'claude-code' | 'codex' | 'elanous' | 'grok' | 'telegram' | 'pwa';
export interface FileContext {
  lineNo: number; sessionId: string; cwd?: string; automatedCodex: boolean;
  sessionCwds: Record<string, string>; sessionAllowed: Record<string, boolean>;
  assistantCounts: Record<string, Record<string, number>>;
  firstCwd?: string; accepted?: boolean;
}
export interface SourceOptions {
  claudeRoot?: string;
  codexRoot?: string;
  codexRoots?: string[];
  grokRoot?: string;
  sessionRoots?: string[];
  surfaceDb?: string;
  projectNames?: string[];
  offsets?: Record<string, number>;
  contexts?: Record<string, FileContext>;
  fileStats?: Record<string, { size: number | null; mtime_ms: number | null }>;
}
