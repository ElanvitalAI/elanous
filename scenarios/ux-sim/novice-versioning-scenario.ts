/** Screen-only novice journeys for app version restore and safe change preview. */
export type NoviceVersioningTask = "restore-yesterday" | "preview-discard" | "preview-apply";
type ScreenId = "home" | "history" | "change-request" | "preview" | "restored" | "discarded" | "applied";
export type NoviceVersioningFault = "apply-routes-to-discard" | "apply-reports-wrong-version" | "applied-screen-has-forbidden-word";

export interface NoviceScreen {
  readonly id: ScreenId;
  readonly title: string;
  readonly body: string;
  /** Version that becomes current only when this screen is entered. */
  readonly versionOnEnter?: string;
  readonly choices: readonly { readonly label: string; readonly next: ScreenId }[];
}

export interface NoviceTaskEvidence {
  readonly task: NoviceVersioningTask;
  readonly userPrompt: string;
  readonly pass: boolean;
  readonly clicks: number;
  /** Step-based screen-reading and click estimate, not wall-clock timing. */
  readonly elapsedSeconds: number;
  /** A scripted choice was unavailable; this does not measure novice comprehension. */
  readonly stuckScreens: readonly string[];
  readonly forbiddenWords: readonly string[];
  readonly visitedScreens: readonly ScreenId[];
  readonly finalVersion: string;
}

// Source: 내부 문서 `app-source-and-git` §2 — each novice task must finish within one minute.
const MAX_TASK_SECONDS = 60;
// Source: 내부 문서 `app-source-and-git` §2 — step-based screen-reading and click estimate.
const SECONDS_PER_SCREEN = 9;
// Source: 내부 문서 `app-source-and-git` §2 — step-based screen-reading and click estimate.
const SECONDS_PER_CLICK = 3;
// Source: 내부 문서 `app-source-and-git` §2 — includes the novice typed change request.
const SECONDS_PER_CHANGE_REQUEST = 5;
const FORBIDDEN_SCREEN_WORDS = ["git", "commit", "branch", "pr", "merge", "커밋", "브랜치", "머지"] as const;

/** This catalog is the only text shown to the simulated novice. */
export const NOVICE_VERSIONING_SCREENS: Readonly<Record<ScreenId, NoviceScreen>> = {
  home: {
    id: "home", title: "내 앱", body: "지금 쓰는 모습과 저장한 판을 관리해요.",
    choices: [
      { label: "저장한 버전 보기", next: "history" },
      { label: "바꿔 보기", next: "change-request" },
    ],
  },
  history: {
    id: "history", title: "저장한 버전", body: "오늘 · 버튼 색을 파란색으로 바꿨어요\n어제 · 처음 만든 모습이에요",
    choices: [{ label: "어제 버전으로 되돌리기", next: "restored" }],
  },
  "change-request": {
    id: "change-request", title: "바꿔 볼 내용을 적어 주세요", body: "버튼 색을 초록색으로 바꿔 주세요.",
    choices: [{ label: "미리 보기 만들기", next: "preview" }],
  },
  preview: {
    id: "preview", title: "바뀐 모습", body: "버튼 색이 초록색으로 바뀌었어요. 마음에 들지 않으면 버릴 수 있어요.",
    choices: [
      { label: "적용하기", next: "applied" },
      { label: "버리기", next: "discarded" },
    ],
  },
  restored: { id: "restored", title: "어제 모습으로 돌아왔어요", body: "저장한 버전은 그대로 남아 있어요.", versionOnEnter: "version-yesterday", choices: [] },
  discarded: { id: "discarded", title: "바꾼 내용을 버렸어요", body: "원래 모습은 그대로예요.", versionOnEnter: "version-today", choices: [] },
  applied: { id: "applied", title: "새 모습을 적용했어요", body: "바뀐 모습이 현재 앱에 저장됐어요.", versionOnEnter: "version-color-change", choices: [] },
};

const ACTIONS: Readonly<Record<NoviceVersioningTask, readonly string[]>> = {
  "restore-yesterday": ["저장한 버전 보기", "어제 버전으로 되돌리기"],
  "preview-discard": ["바꿔 보기", "미리 보기 만들기", "버리기"],
  "preview-apply": ["바꿔 보기", "미리 보기 만들기", "적용하기"],
};

const TERMINAL: Readonly<Record<NoviceVersioningTask, ScreenId>> = {
  "restore-yesterday": "restored",
  "preview-discard": "discarded",
  "preview-apply": "applied",
};

const EXPECTED_FINAL_VERSION: Readonly<Record<NoviceVersioningTask, string>> = {
  "restore-yesterday": "version-yesterday",
  "preview-discard": "version-today",
  "preview-apply": "version-color-change",
};

const USER_PROMPT: Readonly<Record<NoviceVersioningTask, string>> = {
  "restore-yesterday": "어제 버전으로 되돌리기",
  "preview-discard": "버튼 색을 바꿔 보고 마음에 들지 않으면 버리기",
  "preview-apply": "버튼 색을 바꿔 보고 마음에 들면 적용하기",
};

function forbiddenWordsOnVisitedScreens(visited: readonly ScreenId[], screens: Readonly<Record<ScreenId, NoviceScreen>>): string[] {
  const screenText = visited.map((id) => {
    const screen = screens[id];
    return [screen.title, screen.body, ...screen.choices.map((choice) => choice.label)].join("\n");
  }).join("\n");
  return FORBIDDEN_SCREEN_WORDS.filter((word) => {
    if (word === "커밋" || word === "브랜치" || word === "머지") return screenText.includes(word);
    return new RegExp(`\\b${word}\\b`, "i").test(screenText);
  });
}

export function runNoviceVersioningTask(task: NoviceVersioningTask, screens: Readonly<Record<ScreenId, NoviceScreen>> = NOVICE_VERSIONING_SCREENS): NoviceTaskEvidence {
  const actions = ACTIONS[task];
  const terminal = TERMINAL[task];
  const visited: ScreenId[] = ["home"];
  const stuckScreens: string[] = [];
  let screenId: ScreenId = "home";
  let clicks = 0;
  let actionIndex = 0;
  let currentVersion = "version-today";

  while (screenId !== terminal) {
    const screen: NoviceScreen = screens[screenId];
    const action = actions[actionIndex];
    const choice: NoviceScreen["choices"][number] | undefined = screen.choices.find((candidate) => candidate.label === action);
    if (!choice) {
      stuckScreens.push(screen.id);
      break;
    }
    clicks += 1;
    actionIndex += 1;
    screenId = choice.next;
    visited.push(screenId);
    currentVersion = screens[screenId].versionOnEnter ?? currentVersion;
  }

  const forbiddenWords = forbiddenWordsOnVisitedScreens(visited, screens);
  const changeRequestSeconds = task === "restore-yesterday" ? 0 : SECONDS_PER_CHANGE_REQUEST;
  const elapsedSeconds = visited.length * SECONDS_PER_SCREEN + clicks * SECONDS_PER_CLICK + changeRequestSeconds;
  const pass = screenId === terminal && actionIndex === actions.length && stuckScreens.length === 0
    && currentVersion === EXPECTED_FINAL_VERSION[task] && forbiddenWords.length === 0 && elapsedSeconds <= MAX_TASK_SECONDS;
  return { task, userPrompt: USER_PROMPT[task], pass, clicks, elapsedSeconds, stuckScreens, forbiddenWords, visitedScreens: visited,
    finalVersion: currentVersion };
}

export function runNoviceVersioningScenario(fault?: NoviceVersioningFault): NoviceTaskEvidence[] {
  const tasks: NoviceVersioningTask[] = ["restore-yesterday", "preview-discard", "preview-apply"];
  if (!fault) return tasks.map((task) => runNoviceVersioningTask(task));
  const screens: Record<ScreenId, NoviceScreen> = { ...NOVICE_VERSIONING_SCREENS };
  if (fault === "apply-routes-to-discard") {
    screens.preview = { ...screens.preview, choices: screens.preview.choices.map((choice) => choice.label === "적용하기"
      ? { ...choice, next: "discarded" as const } : choice) };
  } else if (fault === "apply-reports-wrong-version") {
    screens.applied = { ...screens.applied, versionOnEnter: "version-today" };
  } else if (fault === "applied-screen-has-forbidden-word") {
    screens.applied = { ...screens.applied, title: "git 화면" };
  }
  return tasks.map((task) => runNoviceVersioningTask(task, screens));
}
