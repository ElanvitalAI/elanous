// I7 (2026-05-12) — MemoIntakePreview render contract + source-level
// wire pin. Network call + swipe + register dispatch run in the browser
// only (no jsdom in `bun test`), so we pin the endpoint paths +
// decision tables via grep — the runtime path is exercised by the Dia
// CDP dogfood walkthrough described in the HANDOFF.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoIntakePreview } from './MemoIntakePreview';
import { MemoIntakeCard } from './MemoIntakeCard';
import { flattenToCards, type PreviewMission } from '@/lib/intake-pipeline-api';
import { DaemonContext } from '@/components/providers/DaemonProvider';

const HERE = dirname(fileURLToPath(import.meta.url));
const PREVIEW_SRC = readFileSync(join(HERE, 'MemoIntakePreview.tsx'), 'utf8');
const API_SRC = readFileSync(
  join(HERE, '..', '..', 'lib', 'intake-pipeline-api.ts'),
  'utf8',
);
const PAGE_SRC = readFileSync(
  join(HERE, '..', '..', 'app', 'intake', 'page.tsx'),
  'utf8',
);

const STUB_DAEMON = {
  config: { baseUrl: '', token: '', provider: '' },
  setConfig: () => {},
  client: {} as never,
  sessionId: 'sess-test',
  setSessionId: () => {},
};

const SAMPLE_MISSION: PreviewMission = {
  id: 'm-1',
  title: 'Diagram + video boost',
  intent: 'Absorb diagram + video tooling',
  taskCount: 2,
  tasks: [
    {
      id: 't-1',
      taskKey: 'm-1/t-1',
      title: 'Inspect openscreen repo',
      intent: 'Scope screen-recording merge plan',
      confidence: 'medium',
      urls: ['https://github.com/siddharthvaddem/openscreen'],
      keywords: [],
      refs: [],
      enrichmentCount: 1,
      category: 'research',
      workflowEligible: true,
      priority: 'medium',
    },
    {
      id: 't-2',
      taskKey: 'm-1/t-2',
      title: 'Mermaid live render plan',
      intent: 'LLM-driven mermaid pop-up flow',
      confidence: 'high',
      urls: [],
      keywords: ['mermaid', 'kitty'],
      refs: [],
      enrichmentCount: 0,
      category: 'dev-feature',
      workflowEligible: true,
      priority: 'high',
    },
  ],
};

describe('MemoIntakePreview · initial render', () => {
  test('shows textarea + Run preview button before submit', () => {
    const html = renderToStaticMarkup(
      <DaemonContext.Provider value={STUB_DAEMON}>
        <MemoIntakePreview />
      </DaemonContext.Provider>,
    );
    expect(html).toContain('data-testid="memo-intake-preview"');
    expect(html).toContain('data-testid="memo-intake-textarea"');
    expect(html).toContain('data-testid="memo-intake-submit"');
    expect(html).toContain('data-testid="memo-intake-photo"');
    expect(html).toContain('data-testid="memo-intake-photo-input"');
    expect(html).toContain('Run preview');
    // FU-I7a / FU8 PR #2 — LLM toggle visible at initial render with
    // affirmative label ("Enable Real LLM"). Off-state copy moved to
    // the descriptive sentence after the em-dash.
    expect(html).toContain('data-testid="memo-intake-llm-toggle"');
    expect(html).toContain('Enable Real LLM');
    expect(html).toContain('skeleton fallback');
    // FU-I7c / FU8 PR #2 — commit toggle visible at initial render
    // (default off → "In-memory store only" descriptive sentence).
    expect(html).toContain('data-testid="memo-intake-commit-toggle"');
    expect(html).toContain('Commit to real TOX');
    expect(html).toContain('in-memory store');
    // FU-I7b / FU8 PR #2 — enrich toggle visible at initial render
    // (default off).
    expect(html).toContain('data-testid="memo-intake-enrich-toggle"');
    expect(html).toContain('Enable Real enrich');
    expect(html).toContain('no plugin');
    // No deck before fetch.
    expect(html).not.toContain('data-testid="memo-deck"');
    expect(html).not.toContain('data-testid="memo-intake-register"');
    expect(html).not.toContain('data-testid="memo-intake-approve-pending"');
    expect(html).not.toContain('data-testid="memo-intake-summary"');
    expect(html).not.toContain('data-testid="memo-intake-tally"');
    expect(html).not.toContain('data-testid="memo-intake-refine"');
  });

  test('Korean swipe legend describes 4 decisions', () => {
    const html = renderToStaticMarkup(
      <DaemonContext.Provider value={STUB_DAEMON}>
        <MemoIntakePreview />
      </DaemonContext.Provider>,
    );
    expect(html).toContain('거절');
    expect(html).toContain('승인');
    expect(html).toContain('잠시 멈춤');
    expect(html).toContain('펼치기');
  });
});

describe('MemoIntakePreview · source-level wiring', () => {
  test('imports IntakePipelineApi from the wrapper module', () => {
    expect(PREVIEW_SRC).toMatch(
      /import\s*\{[^}]*IntakePipelineApi[^}]*\}\s*from\s*['"]@\/lib\/intake-pipeline-api['"]/,
    );
  });

  test('preview wrapper posts to /v1/intake/pipeline-preview', () => {
    expect(API_SRC).toContain("'/v1/intake/pipeline-preview'");
    expect(API_SRC).toMatch(/method:\s*'POST'/);
  });

  test('swipe direction table covers all 4 axes', () => {
    expect(PREVIEW_SRC).toContain("left: 'reject'");
    expect(PREVIEW_SRC).toContain("right: 'approve'");
    expect(PREVIEW_SRC).toContain("up: 'defer'");
    expect(PREVIEW_SRC).toContain("down: 'expand'");
  });

  test('keyboard fallback covers arrows + space', () => {
    expect(PREVIEW_SRC).toContain("ArrowLeft: 'reject'");
    expect(PREVIEW_SRC).toContain("ArrowRight: 'approve'");
    expect(PREVIEW_SRC).toContain("ArrowUp: 'defer'");
    expect(PREVIEW_SRC).toContain("ArrowDown: 'expand'");
    expect(PREVIEW_SRC).toMatch(/' ': 'approve'/);
  });

  test('register path passes register: true to the endpoint', () => {
    expect(PREVIEW_SRC).toMatch(
      /api\.preview\(\s*\{[^}]*register:\s*true[^}]*\}/,
    );
  });

  test('FU-I7d — includeTaskKeys forwarded when user swiped any card', () => {
    expect(PREVIEW_SRC).toContain('approvedTaskKeys');
    expect(PREVIEW_SRC).toContain('includeTaskKeys');
    expect(PREVIEW_SRC).toMatch(
      /anySwiped\s*\?\s*approvedTaskKeys\s*:\s*undefined/,
    );
  });

  test('FU-I7d — approveAllPending flips pending → approved locally only', () => {
    // approveAllPending must NOT call the API; it's purely a local state mutation
    // that the user then commits via [Register].
    expect(PREVIEW_SRC).toContain('approveAllPending');
    // Body of approveAllPending should set verdict to 'approved'.
    expect(PREVIEW_SRC).toMatch(/approveAllPending[\s\S]{0,400}'approved'/);
  });

  test('FU-I7d — wrapper request shape includes optional includeTaskKeys', () => {
    expect(API_SRC).toContain('includeTaskKeys');
    expect(API_SRC).toMatch(/includeTaskKeys\?:\s*string\[\]/);
  });

  test('FU-I7e — handleRefine sends refinementHint + priorDecomposition', () => {
    expect(PREVIEW_SRC).toContain('handleRefine');
    expect(PREVIEW_SRC).toContain('refinementHint');
    expect(PREVIEW_SRC).toContain('priorDecomposition');
    // body must thread the user's hint into the API call (not just the
    // form state — the actual outgoing request).
    expect(PREVIEW_SRC).toMatch(
      /api\.preview\(\s*\{[\s\S]{0,400}refinementHint:\s*trimmedHint[\s\S]{0,400}priorDecomposition/,
    );
  });

  test('FU-I7e — refinement resets verdicts so the user re-decides', () => {
    // After a successful refine the previous swipe verdicts are wiped
    // (new ids would otherwise carry stale "approved/rejected" state).
    // Scope the check to the handleRefine body: cut from its useCallback
    // opening to the next top-level const declaration.
    const m = PREVIEW_SRC.match(/const handleRefine[\s\S]+?(?=\n  const )/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('setVerdicts({})');
    expect(m![0]).toContain('setRefineHint');
    expect(m![0]).toContain('setRefineOpen(false)');
  });

  test('FU-I7e — wrapper request shape includes refinementHint + priorDecomposition', () => {
    expect(API_SRC).toContain('refinementHint?: string');
    expect(API_SRC).toMatch(/priorDecomposition\?:\s*\{\s*missions:/);
  });

  test('FU-I7f — submitPhotoOcr wrapper posts multipart to /v1/notes/from-image', () => {
    expect(API_SRC).toContain('submitPhotoOcr');
    expect(API_SRC).toContain("'/v1/notes/from-image'");
    expect(API_SRC).toContain('FormData');
    expect(API_SRC).toContain("polishMode");
    expect(API_SRC).toContain("'minimal'");
  });

  test('FU-I7a — useRealLlm toggle wires the body flag', () => {
    expect(PREVIEW_SRC).toContain('useRealLlm');
    expect(PREVIEW_SRC).toContain('setUseRealLlm');
    // The toggle state must be forwarded to api.preview() in every call
    // site (submit · refine · register).
    const submitMatch = PREVIEW_SRC.match(/const handleSubmit[\s\S]+?(?=\n  const )/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).toContain('useRealLlm ? { useRealLlm: true }');
    const refineMatch = PREVIEW_SRC.match(/const handleRefine[\s\S]+?(?=\n  const )/);
    expect(refineMatch).not.toBeNull();
    expect(refineMatch![0]).toContain('useRealLlm ? { useRealLlm: true }');
    const registerMatch = PREVIEW_SRC.match(/const handleRegister[\s\S]+?(?=\n  const )/);
    expect(registerMatch).not.toBeNull();
    expect(registerMatch![0]).toContain('useRealLlm ? { useRealLlm: true }');
  });

  test('FU-I7a — wrapper request shape includes useRealLlm + provider + model', () => {
    expect(API_SRC).toMatch(/useRealLlm\?:\s*boolean/);
    expect(API_SRC).toMatch(/provider\?:\s*string/);
    expect(API_SRC).toMatch(/model\?:\s*string/);
  });

  test('FU-I7c — wrapper has commit() method targeting /v1/intake/pipeline-commit', () => {
    expect(API_SRC).toContain('commit(');
    expect(API_SRC).toContain("'/v1/intake/pipeline-commit'");
  });

  test('FU-I7c — handleRegister routes through api.commit when commitToTox=true', () => {
    expect(PREVIEW_SRC).toContain('commitToTox');
    expect(PREVIEW_SRC).toContain('api.commit(');
    // The toggle decides between commit (real TOX) and preview-with-register
    // (in-memory). Both must appear in the same flow.
    const registerMatch = PREVIEW_SRC.match(/const handleRegister[\s\S]+?(?=\n  const )/);
    expect(registerMatch).not.toBeNull();
    expect(registerMatch![0]).toContain('api.commit');
    expect(registerMatch![0]).toContain('api.preview');
    expect(registerMatch![0]).toContain('register: true');   // preview fallback
  });

  test('FU-I7c — destination label flips with the commit toggle', () => {
    // Toast / registered surface must spell out the destination so the
    // user has truth-in-metadata: real-TOX commits vs. in-memory.
    expect(PREVIEW_SRC).toContain('~/.elanous/tasks/tasks.db');
    expect(PREVIEW_SRC).toContain('in-memory');
  });

  test('FU-I7b — useRealEnrich toggle wires the body flag in every call site', () => {
    expect(PREVIEW_SRC).toContain('useRealEnrich');
    expect(PREVIEW_SRC).toContain('setUseRealEnrich');
    const submitMatch = PREVIEW_SRC.match(/const handleSubmit[\s\S]+?(?=\n  const )/);
    expect(submitMatch).not.toBeNull();
    expect(submitMatch![0]).toContain('useRealEnrich ? { useRealEnrich: true }');
    const refineMatch = PREVIEW_SRC.match(/const handleRefine[\s\S]+?(?=\n  const )/);
    expect(refineMatch).not.toBeNull();
    expect(refineMatch![0]).toContain('useRealEnrich ? { useRealEnrich: true }');
    const registerMatch = PREVIEW_SRC.match(/const handleRegister[\s\S]+?(?=\n  const )/);
    expect(registerMatch).not.toBeNull();
    expect(registerMatch![0]).toContain('useRealEnrich ? { useRealEnrich: true }');
  });

  test('FU-I7b — wrapper request shape includes useRealEnrich', () => {
    expect(API_SRC).toMatch(/useRealEnrich\?:\s*boolean/);
  });

  test('FU-I7f — camera button wires submitPhotoOcr + prepends OCR markdown', () => {
    expect(PREVIEW_SRC).toContain('handlePhotoChange');
    expect(PREVIEW_SRC).toContain('submitPhotoOcr');
    // The OCR markdown must be prepended to the existing textarea so
    // the user can correct OCR errors in context.
    expect(PREVIEW_SRC).toMatch(/setRawText\(\s*\(prev\)\s*=>/);
    expect(PREVIEW_SRC).toContain('memo-intake-photo-input');
    // capture="environment" makes iOS open the rear camera directly.
    expect(PREVIEW_SRC).toContain('capture="environment"');
  });

  test('FU8 PR #2 — every toggle emits pwa.selection.toggle_change on change', () => {
    // The reference 3-sink pattern from FU8 PR #1 (D8.2 + M4-4.2 +
    // M4-6.2) is copied here at the PWA's selection boundary. Each
    // of the 3 toggles (LLM / enrich / commit) must call the
    // `emitToggleChange` helper inside its onChange so dashboards /
    // Patcher see the user flipping the switch. The helper itself
    // must route through `userIntentLogger` (PWA wrapper that POSTs
    // to `/v1/user-intents/emit`).
    expect(PREVIEW_SRC).toContain('emitToggleChange');
    expect(PREVIEW_SRC).toMatch(
      /import\s*\{\s*userIntentLogger\s*\}\s*from\s*['"]@\/lib\/user-intent-logger['"]/,
    );
    // Three distinct toggle ids — each emitted with the prior + next
    // boolean (`{ from, to }`) so the consumer can reconstruct the
    // exact transition.
    expect(PREVIEW_SRC).toContain("emitToggleChange('use-real-llm'");
    expect(PREVIEW_SRC).toContain("emitToggleChange('use-real-enrich'");
    expect(PREVIEW_SRC).toContain("emitToggleChange('commit-to-tox'");
    expect(PREVIEW_SRC).toContain("kind: 'pwa.selection.toggle_change'");
    expect(PREVIEW_SRC).toContain("target: { kind: 'toggle'");
    expect(PREVIEW_SRC).toContain('value: { from, to }');
  });

  test('FU8 PR #2 — toggle labels are affirmative + checked-state colour emphasis preserved', () => {
    // Labels are now constant across checked/unchecked — the strong
    // colour class flips with the toggle to communicate state.
    expect(PREVIEW_SRC).toContain('Enable Real LLM');
    expect(PREVIEW_SRC).toContain('Enable Real enrich');
    expect(PREVIEW_SRC).toContain('Commit to real TOX');
    // Checked-state colour emphasis still wired (foreground for LLM /
    // enrich, rose for commit).
    expect(PREVIEW_SRC).toMatch(/useRealLlm \? 'text-foreground' : ''/);
    expect(PREVIEW_SRC).toMatch(/useRealEnrich \? 'text-foreground' : ''/);
    expect(PREVIEW_SRC).toMatch(/commitToTox \? 'text-rose-700 dark:text-rose-400' : ''/);
  });

  test('optional initialMemo seeds the field and onClose runs from reset; omitted props keep the preview path', () => {
    expect(PREVIEW_SRC).toContain('initialMemo?: string');
    expect(PREVIEW_SRC).toContain('onClose?: () => void');
    expect(PREVIEW_SRC).toContain("useState(initialMemo ?? '')");
    expect(PREVIEW_SRC).toContain('onClose?.()');
    expect(PREVIEW_SRC).toContain('api.preview(');
    expect(API_SRC).toContain("'/v1/intake/pipeline-preview'");
    expect(PAGE_SRC).toContain('<IntakeFrontDoor />');
    expect(PAGE_SRC).not.toContain('router.replace');
    expect(PAGE_SRC).not.toContain("'/autopilot'");
  });
});

describe('MemoIntakeCard · render contract', () => {
  test('renders mission title, task title, intent, badges', () => {
    const cards = flattenToCards([SAMPLE_MISSION]);
    const html = renderToStaticMarkup(
      <div style={{ position: 'relative' }}>
        <MemoIntakeCard card={cards[0]!} verdict="pending" active stackIndex={0} />
      </div>,
    );
    expect(html).toContain('data-testid="memo-intake-card"');
    expect(html).toContain('Diagram + video boost');
    expect(html).toContain('Inspect openscreen repo');
    expect(html).toContain('Scope screen-recording merge plan');
    expect(html).toContain('data-testid="memo-card-category"');
    expect(html).toContain('research');
    expect(html).toContain('workflow');
    expect(html).toContain('1 ref');
    // Hint footer is only on the active card.
    expect(html).toContain('data-testid="memo-card-hint"');
    expect(html).toContain('승인 →');
  });

  test('non-active card omits the swipe-hint footer', () => {
    const cards = flattenToCards([SAMPLE_MISSION]);
    const html = renderToStaticMarkup(
      <MemoIntakeCard card={cards[1]!} verdict="approved" active={false} stackIndex={1} />,
    );
    expect(html).toContain('data-testid="memo-intake-card"');
    expect(html).toContain('data-verdict="approved"');
    expect(html).not.toContain('data-testid="memo-card-hint"');
  });
});

describe('flattenToCards', () => {
  test('produces one card per task with mission title attached', () => {
    const cards = flattenToCards([SAMPLE_MISSION]);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.missionTitle).toBe('Diagram + video boost');
    expect(cards[0]!.task.taskKey).toBe('m-1/t-1');
    expect(cards[1]!.task.taskKey).toBe('m-1/t-2');
  });

  test('returns empty array when given no missions', () => {
    expect(flattenToCards([])).toEqual([]);
  });
});
