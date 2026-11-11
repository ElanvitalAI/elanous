import { expect, test } from "bun:test";
import { NOVICE_VERSIONING_SCREENS, runNoviceVersioningScenario } from "../../scenarios/ux-sim/novice-versioning-scenario.js";

const FORBIDDEN_UI_WORDS = /\b(?:git|commit|branch|pr|merge)\b|커밋|브랜치|머지/i;

test("novice versioning screen journeys restore, preview, discard, and apply within one minute", () => {
  const evidence = runNoviceVersioningScenario();
  expect(evidence).toHaveLength(3);
  expect(evidence.every((task) => task.pass)).toBe(true);
  // Source: 내부 문서 `app-source-and-git` §2 — each novice prompt resolves in under one minute.
  expect(evidence.map(({ task, userPrompt, clicks, elapsedSeconds, stuckScreens, finalVersion }) => ({
    task, userPrompt, clicks, elapsedSeconds, stuckScreens, finalVersion,
  }))).toEqual([
    { task: "restore-yesterday", userPrompt: "어제 버전으로 되돌리기", clicks: 2, elapsedSeconds: 33, stuckScreens: [], finalVersion: "version-yesterday" },
    { task: "preview-discard", userPrompt: "버튼 색을 바꿔 보고 마음에 들지 않으면 버리기", clicks: 3, elapsedSeconds: 50, stuckScreens: [], finalVersion: "version-today" },
    { task: "preview-apply", userPrompt: "버튼 색을 바꿔 보고 마음에 들면 적용하기", clicks: 3, elapsedSeconds: 50, stuckScreens: [], finalVersion: "version-color-change" },
  ]);
  expect(evidence.every((task) => task.elapsedSeconds < 60 && task.forbiddenWords.length === 0)).toBe(true);

  const visibleCopy = Object.values(NOVICE_VERSIONING_SCREENS)
    .flatMap(({ title, body, choices }) => [title, body, ...choices.map(({ label }) => label)]).join("\n");
  expect(visibleCopy).not.toMatch(FORBIDDEN_UI_WORDS);
});
