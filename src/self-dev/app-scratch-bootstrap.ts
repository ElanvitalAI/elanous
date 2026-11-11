/** Narrow bootstrap policy for a natural-language app request in an explicitly empty folder. */
export interface AppScratchBootstrapInput {
  readonly request: string;
  readonly naturalLanguageDispatch: boolean;
  readonly targetStatus: string;
  readonly entries: readonly string[];
}

export interface AppScratchBootstrapPlan {
  readonly autoInitGit: boolean;
  readonly inferredTargetPaths: readonly string[];
}

const APP_REQUEST = /(?:\b(?:app|website|web\s*app|site)\b|앱|웹사이트|웹\s*앱|사이트)/iu;
const NEW_APP_REQUEST = /(?:\b(?:create|build|make|generate|scaffold)\s+(?:[\p{L}\p{N}-]+\s+){0,6}(?:app|website|site)\b|(?:새로운|새|신규)?\s*(?:웹\s*앱|앱|웹사이트|사이트)(?:을|를|이|가)?\s*(?:만들|생성)|(?:만들|생성)(?:어줘|해줘)?\s*(?:새로운\s*)?(?:웹\s*앱|앱|웹사이트|사이트))/iu;
const MODIFY_OR_NEGATED_CREATE = /(?:\b(?:changes?|modifications?|updates?|fixes?|edits?)\s+(?:to|for)\s+(?:(?:the|a|an|my|our|this|existing)\s+)?(?:app|website|site)\b|\b(?:modify|update|fix|edit|improve|refactor|change)\s+(?:(?:the|a|an|my|our|this|existing)\s+)?(?:app|website|site)\b|\bnot\s+(?:create|build|make)\b|\bdon['’]t\s+(?:create|build|make|generate|scaffold)\b|아니라|아닌|말고|대신|기존\s*(?:앱|웹사이트|사이트)\s*(?:수정|고치|변경|개선|업데이트))/iu;
const EXPLICIT_PATH = /(?:^|\n)\s*(?:대상\s*경로|target\s*paths?)\s*:/iu;
const EXPLICIT_FILE = /(?:^|[\s`])(?:[\w.-]+\/)*[\w.-]+\.[\w.-]+(?:\b|`)/u;
const EXPLICIT_SLASH_PATH = /(?:^|[\s`])(?:\.\.?\/|[\w.-]+\/)(?:[\w.-]+\/)*[\w.-]*(?:\/)?(?=$|[\s`,;:.)]|(?:에서|부터|로|을|를|에|아래|쪽))/u;
const EXPLICIT_EXTENSIONLESS_FILE = /(?:^|[\s`])(?:Dockerfile|Makefile|Gemfile|Procfile|README|LICENSE)(?:\b|`)/iu;
const NON_WEB_APP = /\b(?:ios|android|swiftui|react\s*native|flutter|wpf|winui|maui|tauri|gtk|qt)\b|\b(?:electron|macos|mac\s*os|linux|windows)\b.{0,20}(?:\bapp\b|앱)|\b(?:native|desktop)\b.{0,30}\bapp\b|아이폰|안드로이드|윈도우\s*(?:네이티브\s*)?앱|맥\s*앱|리눅스\s*네이티브\s*앱|데스크톱\s*앱/iu;

function isAppCreationRequest(request: string): boolean {
  return APP_REQUEST.test(request) && NEW_APP_REQUEST.test(request) && !MODIFY_OR_NEGATED_CREATE.test(request);
}

/**
 * Infer a conservative first-page web-app shape only for an empty, explicitly selected folder.
 * Existing files, non-app requests, and native-app requests are left to normal grounding.
 */
export function planAppScratchBootstrap(input: AppScratchBootstrapInput): AppScratchBootstrapPlan {
  const request = input.request.trim();
  const eligible = input.naturalLanguageDispatch
    && input.targetStatus === 'non-git-dir'
    && input.entries.length === 0
    && isAppCreationRequest(request);
  if (!eligible) return { autoInitGit: false, inferredTargetPaths: [] };

  const hasExplicitPaths = EXPLICIT_PATH.test(request) || EXPLICIT_FILE.test(request) || EXPLICIT_SLASH_PATH.test(request) || EXPLICIT_EXTENSIONLESS_FILE.test(request);
  if (hasExplicitPaths || NON_WEB_APP.test(request)) {
    return { autoInitGit: true, inferredTargetPaths: [] };
  }
  if (/\b(?:react|vite)\b|리액트/iu.test(request)) {
    return { autoInitGit: true, inferredTargetPaths: ['index.html', 'src/main.tsx', 'src/App.tsx', 'src/styles.css', 'package.json'] };
  }
  return { autoInitGit: true, inferredTargetPaths: ['index.html', 'src/app.js', 'src/styles.css'] };
}
