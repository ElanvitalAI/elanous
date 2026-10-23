// ASIDE-TAB-REUSE (10-22) — the browser guidance must teach «reattach one working tab», not «openTab per step».
import { describe, expect, test } from 'bun:test';
import { ASIDE_BROWSER_GUIDANCE, buildSessionGuidanceAddendum } from './session-guidance.js';
import { buildUniversalPreamble } from './universal-preamble.js';

const cwd = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/** The reattach snippet the guidance hands the model, with placeholders filled in. */
function reattachSnippet(prefix: string, url: string): string {
  const m = /`(const t1=[^`]+)`/.exec(ASIDE_BROWSER_GUIDANCE);
  if (!m) throw new Error('reattach snippet missing from ASIDE_BROWSER_GUIDANCE');
  return m[1]!.replace('<origin+path>', prefix).replace('<url>', url);
}

/** Run the snippet against fake Aside REPL globals and record what it did. */
async function runSnippet(openTabs: Array<{ targetId: string; url: string }>): Promise<string[]> {
  const calls: string[] = [];
  const listBrowserTabs = async () => openTabs;
  const attachBrowserTab = async (id: string) => { calls.push(`attach:${id}`); };
  const openTab = async (url: string) => { calls.push(`open:${url}`); };
  const code = reattachSnippet('https://n8n.example.com/workflow/W1', 'https://n8n.example.com/workflow/W1');
  const fn = new Function('listBrowserTabs', 'attachBrowserTab', 'openTab', `return (async () => { ${code} })();`);
  await fn(listBrowserTabs, attachBrowserTab, openTab);
  return calls;
}

describe('aside browser guidance', () => {
  test('emitted for shell-capable and aside-tool sessions, in both TUIs’ shared preamble', () => {
    for (const tools of [['Bash'], ['RunShell'], ['aside.repl']]) {
      const content = String(buildSessionGuidanceAddendum(tools)[0]?.content ?? '');
      expect(content).toContain(ASIDE_BROWSER_GUIDANCE);
    }
    const preamble = buildUniversalPreamble({ cwd, enabledTools: ['Bash'] }).map(m => String(m.content)).join('\n');
    expect(preamble).toContain(ASIDE_BROWSER_GUIDANCE);
  });

  test('not emitted when no shell or aside tool exists', () => {
    const content = buildSessionGuidanceAddendum(['Read', 'Grep']).map(m => String(m.content)).join('\n');
    expect(content).not.toContain('aside repl');
  });

  test('names list → attach → open-only-if-missing, plus the bare-repl and timeout rules', () => {
    for (const piece of ['listBrowserTabs()', 'attachBrowserTab(', 'openTab()` only when no matching tab exists', 'bare `aside repl`', '120s', '150000']) {
      expect(ASIDE_BROWSER_GUIDANCE).toContain(piece);
    }
  });

  test('the snippet reattaches an existing matching tab and does not open a new one', async () => {
    const calls = await runSnippet([
      { targetId: 'T-other', url: 'https://example.org/' },
      { targetId: 'T-n8n', url: 'https://n8n.example.com/workflow/W1/node-3' },
    ]);
    expect(calls).toEqual(['attach:T-n8n']);
  });

  test('the snippet opens a tab only when none matches', async () => {
    const calls = await runSnippet([{ targetId: 'T-other', url: 'https://example.org/' }]);
    expect(calls).toEqual(['open:https://n8n.example.com/workflow/W1']);
  });
});

// 재현 — ASIDE-TAB-REUSE 사고(10-22 22:5x · n8n 특강 세션 elanous-session-bif5y7).
// 관측 원문: 매 단계 `Bash(aside repl "var p=await openTab('https://n8n.elanvitaloffice.com/workflow/4jRnAEWOSK9XvU68');…")`.
// 일회성 `aside repl` 은 호출마다 새 세션이라 같은 탭이 쌓여 n8n «Editing in another tab» 잠금이 났다.
describe('ASIDE-TAB-REUSE incident 10-22 — per-step openTab vs reuse guidance', () => {
  const N8N = 'https://n8n.elanvitaloffice.com/workflow/4jRnAEWOSK9XvU68';
  const OBSERVED_STEP = `var p=await openTab('${N8N}');`;

  /** A fake Aside browser shared across one-shot repl calls (the tabs outlive each REPL session). */
  function fakeBrowser() {
    const tabs: Array<{ targetId: string; url: string }> = [];
    const attached: string[] = [];
    const globals = {
      listBrowserTabs: async () => tabs.map(t => ({ ...t })),
      attachBrowserTab: async (id: string) => { attached.push(id); },
      openTab: async (url: string) => { tabs.push({ targetId: `T${tabs.length + 1}`, url }); },
    };
    /** One `aside repl "<code>"` call — a fresh session over the same browser. */
    const replCall = async (code: string) => {
      const fn = new Function('listBrowserTabs', 'attachBrowserTab', 'openTab', `return (async () => { ${code} })();`);
      await fn(globals.listBrowserTabs, globals.attachBrowserTab, globals.openTab);
    };
    return { tabs, attached, replCall };
  }

  test('reproduces the incident: the observed per-step script opens one more n8n tab every step', async () => {
    const b = fakeBrowser();
    for (let step = 0; step < 4; step++) await b.replCall(OBSERVED_STEP);
    expect(b.tabs.filter(t => t.url.startsWith(N8N))).toHaveLength(4);   // 4 tabs of one workflow → editor lock
  });

  test('the new guidance snippet keeps one n8n tab across the same 4 steps and reattaches it', async () => {
    const b = fakeBrowser();
    const code = reattachSnippet(N8N, N8N);
    for (let step = 0; step < 4; step++) await b.replCall(code);
    expect(b.tabs.filter(t => t.url.startsWith(N8N))).toHaveLength(1);
    expect(b.attached).toEqual(['T1', 'T1', 'T1']);
  });

  test('the guidance does not teach the observed openTab-first pattern', () => {
    expect(ASIDE_BROWSER_GUIDANCE).not.toMatch(/var p=await openTab\(/);
    expect(ASIDE_BROWSER_GUIDANCE.indexOf('listBrowserTabs()')).toBeLessThan(ASIDE_BROWSER_GUIDANCE.indexOf('await openTab('));
  });
});
