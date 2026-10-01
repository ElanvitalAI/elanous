import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildUniversalPreamble } from './universal-preamble.js';
import { buildSessionGuidanceAddendum } from './session-guidance.js';

const cwd = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const trackedFilesGuidance = '저장소의 파일 수·목록은 저장소 루트에서 `git ls-files <경로>`로 추적 파일 기준으로 센다 — 하위 디렉터리에서 실행 중이면 저장소 루트로 이동해서 세고, 다른 기준이면 그 기준을 답에 적는다.';
const noToolsGuidance = `## Chat without tools — verify rather than guess
This conversation has tools disabled. Do not guess repository or real-time facts that require verification, such as file counts, file contents, commits, or the current date or time. When asked for facts you cannot verify here (including repository state, files, and dates), explicitly say you cannot check them in this mode. The project tree above is for navigation, not evidence for counts.
Give one line explaining how to enable tools: \`elanous agent "<your question>"\`.`;

function systemContents(enabledTools?: string[]): string[] {
  return buildUniversalPreamble({ cwd, enabledTools })
    .filter(message => message.role === 'system')
    .map(message => String(message.content));
}

describe('repository file counts in the universal preamble', () => {
  it('prepends tracked-file counting guidance to the existing tool-mode guidance', () => {
    for (const tool of ['Bash']) {
      const contents = systemContents([tool]);
      expect(contents.at(-1)?.startsWith(`${trackedFilesGuidance}\n\n# Session-specific guidance`)).toBe(true);
      expect(contents.at(-1)).toBe(String(buildSessionGuidanceAddendum([tool])[0]?.content));
      expect(contents.at(-1)).not.toContain('무시 파일·node_modules·빌드 산출 제외');
      expect(contents).not.toContain(noToolsGuidance);
    }
  });

  it('directs a session in a repository subdirectory to count from the repository root', () => {
    const subdir = join(cwd, 'src', 'prompt-library');
    const rootFiles = spawnSync('git', ['ls-files', 'apps/pwa'], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    const subdirFiles = spawnSync('git', ['ls-files', 'apps/pwa'], { cwd: subdir, encoding: 'utf8', maxBuffer: 1 << 28 });
    const rootedFromSubdir = spawnSync('git', ['-C', cwd, 'ls-files', 'apps/pwa'], { cwd: subdir, encoding: 'utf8', maxBuffer: 1 << 28 });
    expect(rootFiles.status).toBe(0);
    expect(subdirFiles.status).toBe(0);
    expect(rootedFromSubdir.status).toBe(0);
    expect(rootFiles.stdout.trim().length).toBeGreaterThan(0);
    expect(subdirFiles.stdout.trim()).toBe('');
    expect(rootedFromSubdir.stdout).toBe(rootFiles.stdout);

    const contents = buildUniversalPreamble({ cwd: subdir, enabledTools: ['Bash'] })
      .filter(message => message.role === 'system')
      .map(message => String(message.content));
    expect(contents.at(-1)?.startsWith(`${trackedFilesGuidance}\n\n# Session-specific guidance`)).toBe(true);
    expect(contents.at(-1)).toContain('저장소 루트에서 `git ls-files <경로>`로 추적 파일 기준으로 센다');
    expect(contents.at(-1)).toContain('하위 디렉터리에서 실행 중이면 저장소 루트로 이동해서 세고');
  });

  it('keeps the no-tools verification and tool-enabling guidance unchanged', () => {
    for (const contents of [systemContents(), systemContents([])]) {
      expect(contents).toContain(noToolsGuidance);
      expect(contents).not.toContain(trackedFilesGuidance);
    }
  });
});

describe('B4 파일 수 규칙은 명령 도구가 있을 때만 git ls-files — 리뷰 3라운드 must-fix', () => {
  it('a Read-only session is told it cannot count files instead of being told to run git ls-files', () => {
    const joined = systemContents(['Read']).join('\n');
    expect(joined).not.toContain('`git ls-files <경로>`');
    expect(joined).toContain('이 모드에서는 셀 수 없다');
  });
  it('a session with Bash or PtyShellStart gets the git ls-files rule', () => {
    for (const tool of ['Bash', 'PtyShellStart']) expect(systemContents([tool]).join('\n')).toContain('`git ls-files <경로>`');
  });
});
