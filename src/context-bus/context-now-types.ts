export type ContextFact =
  | { kind: 'version'; version: string; source: string }
  | { kind: 'cell'; version: string; id: string; title: string; status: string; owner: string | null; source: string; priority?: string | null }
  | { kind: 'decision'; id: string; title: string; status: string; dueAt: string | null; source: string }
  | { kind: 'seat'; seat: string; at: string; status: string; id: string | null; title: string | null; source: string }
  | { kind: 'run'; goal: string; phase: string; elapsed: string; source: string; unreadable?: string }
  | { kind: 'release'; version: string; node: string; status: string; source: string; unreadable?: string;
      phase?: string; currentNode?: string | null; nextAction?: string;
      gateProgress?: { completed: number; total: number; failed: number } | null;
      regressions?: { introduced: number | null; preexisting: number | null } | null;
      receiptStatus?: 'valid' | 'invalid' | 'absent' | 'unreadable'; waiverEvents?: string[];
      emergencySwitch?: { state: 'on' | 'off' | 'unknown'; reason?: string };
      landingFreeze?: { state: 'on' | 'off' | 'unknown'; reason?: string };
      expectedPublishAt?: string | null; etaMinutes?: number | null;
      auditCoverage?: { uncoveredFiles: number; totalFiles: number } | null; residualRuns?: number | null;
      sweepCertificateAgeMinutes?: number | null;
      failureCounts?: { introduced: number | null; preexisting: number | null; undetermined: number | null } | null;
      sourceRefs?: Array<{ signal: string; source: string }>;
      ledgerErrors?: Array<{ signal: string; source: string; reason: string }> }
  | { kind: 'schedule-late'; count: number | null; names: string[]; source: string; unreadable?: string };
export type ContextEvent = { at: string; kind: string; summary: string; source: string };
export type ContextNowAnswer = { at: string; topic: string | null; facts: ContextFact[]; events: ContextEvent[]; guide: string[]; hiddenCount?: number };
