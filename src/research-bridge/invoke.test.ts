import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setResearchArchiveDir } from './store.js';
import type { SkillManifest } from '../skills/runner.js';
import {
  withResearchIsolation,
  RESEARCH_DENIED_TOOLS,
  researchOutputFromSkillRun,
  researchOutcomeFromSkillRun,
  invokeResearch,
  setResearchInvoker,
  setResearchSkillExecutorForTest,
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

describe('invokeResearch cancellation', () => {
  it('forwards the caller signal to the invoker so bounded follow-ups can stop', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    setResearchInvoker(async (_skill, _args, _progress, signal) => {
      received = signal;
      return { output: 'read-only result', ok: true };
    });
    try {
      const result = await invokeResearch('query', { skill: 'omni-crawl', signal: controller.signal });
      expect(result.ok).toBe(true);
      expect(received).toBe(controller.signal);
    } finally {
      setResearchInvoker(null);
    }
  });
});

describe('invokeResearch selected skill root', () => {
  it('parses the canonical skill from the selected index root without calling an LLM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'research-skill-root-'));
    setResearchArchiveDir(join(root, 'archive'));
    mkdirSync(join(root, 'kr-flow'));
    writeFileSync(join(root, 'kr-flow', 'SKILL.md'), '---\nname: kr-flow\ndescription: fixture\n---\nbody\n');
    let executedName = '';
    setResearchSkillExecutorForTest(async (manifest, args) => {
      executedName = manifest.name;
      expect(args).toBe('mock replay');
      return { finalResponse: 'mock result' };
    });
    try {
      const result = await invokeResearch('mock replay', { skill: 'kr-flow', skillRootDir: root });
      expect(executedName).toBe('kr-flow');
      expect(result).toMatchObject({ skill: 'kr-flow', ok: true, output: 'mock result' });
    } finally {
      setResearchSkillExecutorForTest(null);
      setResearchArchiveDir(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
