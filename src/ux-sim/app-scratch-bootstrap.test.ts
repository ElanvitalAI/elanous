import { describe, expect, test } from 'bun:test';
import { simAppScratchBootstrap } from './app-scratch-bootstrap.js';

describe('simAppScratchBootstrap', () => {
  test('empty natural-language app request auto-inits and supplies first-pass file targets', () => {
    expect(simAppScratchBootstrap({ request: '앱 만들어줘' }).plan).toEqual({
      autoInitGit: true,
      inferredTargetPaths: ['index.html', 'src/app.js', 'src/styles.css'],
    });
  });

  test('react asks get a matching target shape while explicit paths are preserved for grounding', () => {
    expect(simAppScratchBootstrap({ request: 'Build a React web app' }).plan.inferredTargetPaths).toContain('src/App.tsx');
    expect(simAppScratchBootstrap({ request: '웹 앱 만들어줘\n대상 경로: src/App.tsx' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, index.html로 시작' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, frontend/ 아래에 작성' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, frontend/, 아래에 작성' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, README.md부터 작성' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, src/server.py에서 시작' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, src/BUILD에서 시작' }).plan.inferredTargetPaths).toEqual([]);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘, Dockerfile부터 작성' }).plan.inferredTargetPaths).toEqual([]);
  });

  test('does not initialize folders with files, existing repositories, modifications, native apps, or non-natural dispatch', () => {
    expect(simAppScratchBootstrap({ request: 'make changes to the app' }).plan.autoInitGit).toBe(false);
    expect(simAppScratchBootstrap({ request: 'make changes to my app' }).plan.autoInitGit).toBe(false);
    expect(simAppScratchBootstrap({ request: "don't create an app" }).plan.autoInitGit).toBe(false);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘가 아니라 기존 앱 수정해줘' }).plan.autoInitGit).toBe(false);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘', entries: ['notes.md'] }).plan.autoInitGit).toBe(false);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘', targetStatus: 'git-repo' }).plan.autoInitGit).toBe(false);
    expect(simAppScratchBootstrap({ request: '앱 만들어줘', naturalLanguageDispatch: false }).plan.autoInitGit).toBe(false);
    for (const request of ['Create a macOS app', 'Create an Electron app', '앱 만들어줘, Linux 네이티브 앱으로', 'Create a desktop calculator app']) {
      expect(simAppScratchBootstrap({ request }).plan).toEqual({ autoInitGit: true, inferredTargetPaths: [] });
    }
    expect(simAppScratchBootstrap({ request: 'Build a beautiful app' }).plan.autoInitGit).toBe(true);
    expect(simAppScratchBootstrap({ request: 'Build a new app instead of the existing app' }).plan.autoInitGit).toBe(true);
  });
});
