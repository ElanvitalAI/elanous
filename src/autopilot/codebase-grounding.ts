import type { HarnessGroundingProvenance } from '../self-implement/context-capsule.js';

// ⚠️ `<name>` 은 한 구간이며 디렉터리는 정확히, SKILL.md 파일명만 대소문자를 무시한다.
const CLAUDE_SKILL_DOCUMENT = /(?:^|\/)\.claude\/skills\/[^/]+\/[Ss][Kk][Ii][Ll][Ll]\.[Mm][Dd]$/;

/** The sole path policy for repository implementation candidates. */
export function isRepositoryImplementationCandidate(path: string): boolean {
  return !CLAUDE_SKILL_DOCUMENT.test(path.replace(/\\/g, '/'));
}

export interface PersistentGroundingEvidenceItem {
  text: string;
  sourceKind?: HarnessGroundingProvenance;
}

export interface DocumentGroundingMatch {
  path: string;
  score: number;
  matchedTerms: string[];
  excerpt: string;
}

export interface CodebaseGrounding {
  grounded: boolean;
  context: string;   // 분해 objective 에 fold 할 "기존 관련 코드/문서" 맵
  /** `.claude/skills/<name>/SKILL.md` 만 제외한다. 일반적인 저장소 소스 판별은 아니다. */
  files: string[];
  /** Persistent loop completion-evidence lines, preserved verbatim after Read-path verification. */
  persistentEvidence?: string[];
  /** Positional source associations preserve distinct provenance for duplicate evidence text. */
  persistentEvidenceItems?: readonly PersistentGroundingEvidenceItem[];
  persistentStopReason?: string;
  /** 코드 접지 채널의 상태. 빈 파일 결과의 서로 다른 원인을 구분한다. */
  codeChannel?: 'ok' | 'disabled' | 'failed' | 'incomplete';
  skillFacts: string[];
  codeFacts: string[];
  memoryFacts: string[];
  documentFacts: string[];
  documentMatches?: DocumentGroundingMatch[];
  searchTerms?: string[];
  genericSearchScope?: boolean;
  refFacts: string[];
  ptyFacts: string[];
}
