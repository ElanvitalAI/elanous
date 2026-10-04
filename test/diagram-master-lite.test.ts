import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchMermaidRender } from '../src/skills/tools/mermaid.js';

// Lives outside skills/diagram-master so the skill folder imports nothing outside itself (skills-self-contained).
const skillDir = join(import.meta.dir, '../skills/diagram-master');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const project = readFileSync(join(skillDir, 'references/pyproject.toml'), 'utf8');
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

test('Python 없는 기본 경로에서 실제 Mermaid 그림을 렌더한다', async () => {
  process.env.PATH = '';
  const result = await dispatchMermaidRender({ source: 'flowchart LR\n  A[시작] --> B[완료]', format: 'unicode' });
  expect(result.metadata.renderer).toBe('mermaidtui');
  expect(result.display).toContain('시작');
  expect(result.display).toContain('완료');
  expect(result.display).toMatch(/[─│┌┐└┘→▶]/);
  expect(skill).toContain('`MermaidRender({"source":"flowchart LR\\n  A[시작] --> B[완료]"})`');
  expect(skill).toContain('Bash가 아닌 MermaidRender에 전달해 실제 터미널 그림을 얻는다. Python·설치 명령을 실행하지 않는다');
});

test('Python 엔진은 선택 애드온이며 부재 시 설치 안내와 Mermaid 대체를 명시한다', () => {
  expect(project).toMatch(/dependencies = \[\]\s+\[project\.optional-dependencies\]\s+python-engines = \[/);
  for (const dep of ['matplotlib', 'google-generativeai', 'playwright']) {
    expect(project).toContain(`"${dep}>=`);
  }
  expect(skill).toContain('이 엔진은 애드온 설치가 필요합니다 (cd skills/diagram-master/references && uv sync --extra python-engines && uv run --extra python-engines playwright install chromium)');
  expect(skill).toContain('Mermaid로 대체 가능한 요청이면 먼저 Mermaid로 실제 그림을 렌더');
  expect(skill).toContain('정밀 곡선·3D·AI 이미지 등 대체 불가능한 요청');
  expect(skill).toContain('명시적으로 다른 엔진을 요청했다면 대체했음을 밝힌다');
  expect(skill).toContain('없으면 위 한 줄을 안내하고, Mermaid로 대체 가능하면 4로 돌아간다');
});
