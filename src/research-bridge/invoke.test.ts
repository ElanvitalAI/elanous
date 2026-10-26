import { describe, it, expect } from 'bun:test';
import type { SkillManifest } from '../skills/runner.js';
import {
  withResearchIsolation,
  RESEARCH_DENIED_TOOLS,
  researchOutputFromSkillRun,
  researchOutcomeFromSkillRun,
} from './invoke.js';

const mf = (over: Partial<SkillManifest> = {}): SkillManifest =>
  ({ name: 'omni-crawl', description: 'search skill', ...over }) as SkillManifest;

describe('withResearchIsolation (research 격리·main 트리 오염 차단·대표 2026-07-20)', () => {
  it('Write/Edit/NotebookEdit 를 deniedTools 에 추가(codex 가 write 도구 자체를 못 봄)', () => {
    const iso = withResearchIsolation(mf());
    for (const t of RESEARCH_DENIED_TOOLS) expect(iso.deniedTools).toContain(t);
  });

  it('기존 deniedTools 보존 + 중복 제거', () => {
    const iso = withResearchIsolation(mf({ deniedTools: ['Agent', 'Write'] }));
    expect(iso.deniedTools).toContain('Agent');
    expect(iso.deniedTools!.filter((t) => t === 'Write')).toHaveLength(1); // 중복 없음
  });

  it('원본 manifest 불변(순수·spread)', () => {
    const orig = mf({ deniedTools: ['Agent'] });
    withResearchIsolation(orig);
    expect(orig.deniedTools).toEqual(['Agent']); // 원본 그대로
  });

  it('allowedTools·model 등 기타 필드 보존', () => {
    const iso = withResearchIsolation(mf({ allowedTools: ['Read', 'Bash'], model: 'gpt-5.6-sol' }));
    expect(iso.allowedTools).toEqual(['Read', 'Bash']);
    expect(iso.model).toBe('gpt-5.6-sol');
  });

  it('Bash 는 deny 하지 않음 — omni-crawl 검색 CLI(npx tsx)에 필수·skillDir cwd 라 main 트리 밖', () => {
    expect([...RESEARCH_DENIED_TOOLS]).not.toContain('Bash');
  });
});

describe('researchOutputFromSkillRun', () => {
  it('prefers the final assistant answer and removes terminal control sequences', () => {
    expect(researchOutputFromSkillRun({
      finalResponse: '\u001b[32mFinal report\u001b[0m',
    })).toBe('Final report');
  });

  it('marks an aborted run with no final answer as incomplete', () => {
    expect(researchOutcomeFromSkillRun({ finalResponse: '' })).toEqual({
      output: '',
      ok: false,
      error: 'skill run finished without a final assistant response',
    });
  });

});
