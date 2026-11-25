import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 경로 래칫 — src/ 코드에 본부·참조 소스 디렉터리를 박지 않는다(검색 출처는 설정 knowledge.sources /
 * env ELANOUS_SOURCES 에서만 · src/knowledge/search-roots.ts). 주석·시험·fixtures 는 제외.
 * 기존 줄은 파일별 상한(BASELINE)으로 얼려 두고 «늘지 않게»만 막는다 — 줄이면 BASELINE 도 같이 줄인다.
 * 기대값은 독립 리터럴이다.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = /\/elanous-hq\/|\/source\/ref|'elanous-hq'|'source', 'ref'/;
const BASELINE: Record<string, number> = {
  'src/agent-substrate/self-review-cli.ts': 1,
  'src/agent/monad-agent-turn.ts': 1,
  'src/agent/ref-grounding.ts': 1,
  'src/cli/config-drift.ts': 1,
  'src/cli/hosts-cli.ts': 2,
  'src/cli/machine-membership.ts': 3,
  'src/cli/member-file-quick-publish.ts': 1,
  'src/cli/memory-cli.ts': 3,
  'src/cli/ops-30m-check.ts': 1,
  'src/cli/pr-land-conductor-map.ts': 1,
  'src/cli/seat-cli.ts': 8,
  'src/cli/seat-close.ts': 2,
  'src/cli/tasks-cli.ts': 1,
  'src/context-bus/seat-retro.ts': 1,
  'src/dashboard/input/seat-autowake.ts': 3,
  'src/dashboard/input/seat-self-pull-sources.ts': 2,
  'src/directives/sources.ts': 1,
  'src/disk-steward/steward.ts': 1,
  'src/els/mail-wake-watcher.ts': 1,
  'src/els/remote-update.ts': 1,
  'src/execution-loop/launch-gate.ts': 1,
  'src/graph-runner/release-known-issue-waiver.ts': 1,
  'src/graph-runner/release-pwa-known-issue.ts': 1,
  'src/graph-runner/release-pwa-mail-waiver.ts': 1,
  'src/grounding/sources-cli.ts': 1,
  'src/grounding/sources.ts': 1,
  'src/harness/harness-seams.ts': 1,
  'src/hq/repo-maintenance-schedule.ts': 1,
  'src/hq/repo-maintenance.ts': 1,
  'src/hq/seats.ts': 3,
  'src/knowledge/docs-roots.ts': 1,
  'src/knowledge/docs-system-map.ts': 1,
  'src/loops/agent-reply.ts': 3,
  'src/loops/inbox-liveness.ts': 1,
  'src/loops/msg-wake.ts': 1,
  'src/memory.ts': 1,
  'src/msg/seat-mail-trust.ts': 1,
  'src/nexus/api/ops-api.ts': 1,
  'src/op-requirements/requirement-loop.ts': 1,
  'src/ops-dashboard/operating-dashboard.ts': 1,
  'src/ops-dashboard/retro-wiring.ts': 1,
  'src/ops/overview-seat-era.ts': 1,
  'src/prompt-library/universal-preamble.ts': 1,
  'src/release-loop/cloud-elastic.ts': 2,
  'src/repl/seat-owner-turn-e2e.driver.ts': 1,
  'src/seat-loop/op-behavior-e2e.ts': 1,
  'src/seat-loop/traffic-signal.ts': 1,
  'src/seat-memory/op-memory-seed.ts': 3,
  'src/seat/seat-boot-preamble.ts': 6,
  'src/seat/seat-local-instructions.ts': 4,
  'src/seat/seat-retro.ts': 1,
  'src/secret/codex-lease.ts': 1,
  'src/secret/static-lease.ts': 1,
  'src/self-implement/seams.ts': 2,
  'src/shell-primitive/relax-hold.ts': 1,
  'src/skills/tools/schedule-wakeup.ts': 1,
  'src/steward/entrance-dispatch-shadow.ts': 1,
  'src/task-agent/alloc-evidence.ts': 1,
  'src/task-agent/shadow.ts': 1,
  'src/task-agent/train-landing.ts': 1,
  'src/task-orchestrator/surfaces/gate-pod-pool-policy.ts': 1,
  'src/task-orchestrator/surfaces/pod-codex-lease.ts': 1,
  'src/tool-runtime/ref-consult-runtime.ts': 3,
  'src/tui-client/next-mail-wake.ts': 3,
  'src/tui/entry.ts': 2,
  'src/tui/seat-approval-policy.ts': 1,
  'src/tui/seat-mail-arrival.ts': 1,
  'src/tui/seat-mail-boot.ts': 2,
  'src/tui/seat-message-receipts.ts': 1,
  'src/tui/seat-pull-after-goal.ts': 1,
  'src/ux-sim/classic-tui-seat-scenarios.ts': 2,
  'src/ux-sim/next-tui-seat-scenarios.ts': 1,
  'src/ux-sim/sim-world/capsule-events/c2-mail-tool.ts': 1,
  'src/ux-sim/sim-world/capsule-events/c3-trio.ts': 1,
  'src/ux-sim/sim-world/capsule-events/c4-agent-background.ts': 1,
  'src/ux-sim/sim-world/capsule-events/c6-boot-backlog.ts': 1,
  'src/ux-sim/sim-world/daily-regression/scenarios.ts': 5,
  'src/ux-sim/sim-world/daily-regression/seat-tui.ts': 1,
  'src/ux-sim/sim-world/seat-mail-roundtrip/scenarios.ts': 3,
  'src/ux-sim/sim-world/seat-mail/scenarios.ts': 1,
};

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(p, out); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
}

function counts(): Map<string, number> {
  const files: string[] = [];
  walk(join(REPO, 'src'), files);
  const out = new Map<string, number>();
  for (const f of files) {
    let n = 0;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (PATTERN.test(line)) n += 1;
    }
    if (n > 0) out.set(relative(REPO, f), n);
  }
  return out;
}

test('no new hardcoded HQ / reference-source directory literals in src/', () => {
  const over: string[] = [];
  for (const [file, n] of counts()) {
    const allowed = BASELINE[file] ?? 0;
    if (n > allowed) over.push(`${file}: ${n} > ${allowed}`);
  }
  expect(over).toEqual([]);
});

test('the search-source resolver and DocsSearch carry no directory literal', () => {
  const c = counts();
  expect(c.get('src/knowledge/search-roots.ts') ?? 0).toBe(0);
  expect(c.get('src/skills/tools/docs-search.ts') ?? 0).toBe(0);
  expect(c.get('src/agent/search-toolkit.ts') ?? 0).toBe(0);
});
