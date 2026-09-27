import type { Check, HostCheck, Scenario, Step, Surface } from './scenarios.js';

export interface PageDriver {
  goto(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  insertText(text: string): Promise<void>;
  press(key: string): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  /** Latest daemon llm.stream/consume-start log ID; read failure must throw. */
  llmCallCursor(): Promise<number>;
}

export interface CellResult {
  id: string;
  surface: Surface;
  title: string;
  pass: boolean;
  ms: number;
  chipMs?: number;
  evidence: string[];
  failure?: string;
  blocked?: 'no-selector';
}

export type SaveShot = (id: string, image: Buffer) => Promise<string>;

const describe = (value: unknown): string => {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
};

/** Evaluate at least once, then retry until true or the deadline. No unconditional sleep. */
async function poll(driver: PageDriver, js: string, timeoutMs: number, intervalMs: number, onValue?: (value: unknown) => void): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  do {
    last = await driver.evaluate(js);
    onValue?.(last);
    if (last) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (true);
  return last;
}

/** 요소 또는 그 조상이 React 에 붙었는가(`__reactFiber$…`·`__reactProps$…` 키). xterm 처럼 React 밖 DOM 은 조상으로 판정한다. */
export function hydratedJs(selector: string): string {
  return `(() => { let el = document.querySelector(${JSON.stringify(selector)}); while (el) { if (Object.keys(el).some((k) => k.startsWith('__reactFiber') || k.startsWith('__reactProps'))) return true; el = el.parentElement; } return false; })()`;
}

class CellFailure extends Error {
  constructor(message: string, readonly blocked = false) { super(message); }
}

async function runStep(driver: PageDriver, step: Step, url: string): Promise<unknown> {
  switch (step.kind) {
    case 'goto': return driver.goto(url);
    case 'capture': {
      const value = await poll(driver, step.js, step.timeoutMs, 100);
      if (!value) throw new CellFailure(`timed out capturing ${step.key}; last=${describe(value)}`);
      return value;
    }
    case 'waitFor': {
      if (!step.selector && !step.jsPredicate) throw new CellFailure('no-selector', true);
      const js = step.selector
        ? `Boolean(document.querySelector(${JSON.stringify(step.selector)}))`
        : step.jsPredicate!;
      const last = await poll(driver, js, step.timeoutMs, step.intervalMs ?? 100);
      if (!last) throw new CellFailure(`timed out${step.selector ? ` (${step.selector})` : ''}; last=${describe(last)}`);
      return last;
    }
    case 'type': return driver.insertText(step.text);
    case 'press': return driver.press(step.key);
    case 'click': {
      if (!step.selector) throw new CellFailure('no-selector', true);
      const present = await driver.evaluate(`Boolean(document.querySelector(${JSON.stringify(step.selector)}))`);
      if (!present) throw new CellFailure(`selector not rendered (${step.selector}); last=${describe(present)}`);
      // 정적 export 는 React 가 넘겨받기(hydration) «전»에도 같은 DOM 을 보인다 — 그때 누르거나 친 글자는
      // 상태에 안 닿는다(2026-09-27 실측: N5a 가 첫 창에서만 5초 시간 초과). 요소나 조상에 React 표식이 붙을 때까지 기다린다.
      const hydrated = await poll(driver, hydratedJs(step.selector), 10_000, 100);
      if (!hydrated) throw new CellFailure(`not hydrated (${step.selector}); last=${describe(hydrated)}`);
      return driver.click(step.selector);
    }
  }
}

async function runCheck(driver: PageDriver, check: Check, onValue: (value: unknown) => void): Promise<unknown> {
  return poll(driver, check.js, check.timeoutMs ?? 1_000, check.intervalMs ?? 100, onValue);
}

async function runHostCheck(driver: PageDriver, check: HostCheck, baseUrl: string, captured: Readonly<Record<string, unknown>>, onValue: (value: unknown) => void): Promise<boolean> {
  const deadline = Date.now() + check.timeoutMs;
  do {
    const value = await driver.evaluate(check.js);
    onValue(value);
    if (await check.predicate(value, baseUrl, captured)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(check.intervalMs ?? 100, remaining)));
  } while (true);
}

export async function runScenarios(driver: PageDriver, scenarios: readonly Scenario[], baseUrl: string, saveShot?: SaveShot): Promise<CellResult[]> {
  const results: CellResult[] = [];
  for (const scenario of scenarios) {
    const start = Date.now();
    const result: CellResult = { id: scenario.id, surface: scenario.surface, title: scenario.title, pass: false, ms: 0, evidence: [] };
    try {
      let llmBefore: number | undefined;
      if (scenario.id === 'N6a') {
        try {
          llmBefore = await driver.llmCallCursor();
          result.evidence.push(`LLM cursor before: ${llmBefore}`);
        } catch (error) {
          throw new CellFailure(`Check ${scenario.expect.length + 1} (LLM calls remain zero, baseline): ${String(error)}; last=unavailable`);
        }
      }
      const url = new URL(scenario.path, `${baseUrl}/`).href;
      let chipStart: number | undefined;
      const captured: Record<string, unknown> = {};
      for (const [index, step] of scenario.steps.entries()) {
        try {
          const boundedStep = step.kind === 'waitFor' && step.withinChipMs && chipStart !== undefined
            ? { ...step, timeoutMs: Math.max(0, step.timeoutMs - (Date.now() - chipStart)) }
            : step;
          const value = await runStep(driver, boundedStep, url);
          if (step.kind === 'capture') captured[step.key] = value;
          if (scenario.id === 'N5a' && step.kind === 'type') chipStart = Date.now();
          if (step.kind === 'waitFor' && step.measureChip && chipStart !== undefined) {
            result.chipMs = Date.now() - chipStart;
            result.evidence.push(`chipMs: ${result.chipMs}`);
          }
          if (step.kind === 'waitFor' && step.withinChipMs && chipStart !== undefined && Date.now() - chipStart > step.timeoutMs) {
            throw new CellFailure(`absorb chip conditions exceeded ${step.timeoutMs}ms from insertion`);
          }
          result.evidence.push(`Step ${index + 1} (${step.kind}): ${step.kind === 'goto' ? url : describe(value)}`);
        } catch (error) {
          if (step.kind === 'waitFor' && step.measureChip && chipStart !== undefined) {
            result.evidence.push(`chipMs: unavailable (chip not confirmed after ${Date.now() - chipStart}ms)`);
          }
          if (error instanceof CellFailure && error.blocked) result.blocked = 'no-selector';
          const detail = error instanceof Error ? error.message : String(error);
          result.evidence.push(`Step ${index + 1} (${step.kind}): ${detail}`);
          throw new CellFailure(`Step ${index + 1} (${step.kind}): ${detail}`);
        }
      }
      for (const [index, check] of scenario.expect.entries()) {
        let last: unknown;
        try {
          last = await runCheck(driver, check, (value) => { last = value; });
        } catch (error) {
          result.evidence.push(`Check ${index + 1} (${check.expected}): last=${describe(last)}`);
          throw new CellFailure(`Check ${index + 1} (${check.expected}): ${error instanceof Error ? error.message : String(error)}; last=${describe(last)}`);
        }
        result.evidence.push(`Check ${index + 1} (${check.expected}): last=${describe(last)}`);
        if (!last) throw new CellFailure(`Check ${index + 1} (${check.expected}): last=${describe(last)}`);
      }
      for (const [index, check] of (scenario.hostCheck ?? []).entries()) {
        let last: unknown;
        let passed: boolean;
        try {
          passed = await runHostCheck(driver, check, baseUrl, captured, (value) => { last = value; });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          result.evidence.push(`Host check ${index + 1} (${check.expected}): ${detail}; last=${describe(last)}`);
          throw new CellFailure(`Host check ${index + 1} (${check.expected}): ${detail}; last=${describe(last)}`);
        }
        result.evidence.push(`Host check ${index + 1} (${check.expected}): last=${describe(last)}; pass=${passed}`);
        if (!passed) throw new CellFailure(`Host check ${index + 1} (${check.expected}): last=${describe(last)}`);
      }
      if (llmBefore !== undefined) {
        let llmAfter: number;
        try { llmAfter = await driver.llmCallCursor(); }
        catch (error) { throw new CellFailure(`Check ${scenario.expect.length + 1} (LLM calls remain zero): ${String(error)}; last=unavailable`); }
        result.evidence.push(`LLM cursor after: ${llmAfter}; changed=${llmAfter !== llmBefore}`);
        if (llmAfter !== llmBefore) throw new CellFailure(`Check ${scenario.expect.length + 1} (LLM calls remain zero): last=${llmBefore}→${llmAfter}`);
        result.evidence.push(`Check ${scenario.expect.length + 1} (LLM calls remain zero): last=0`);
      }
      result.pass = true;
    } catch (error) {
      result.failure = error instanceof Error ? error.message : String(error);
      if (saveShot) {
        try {
          const path = await saveShot(scenario.id, await driver.screenshot());
          result.evidence.push(`screenshot: ${path}`);
        } catch (shotError) {
          result.evidence.push(`screenshot failed: ${String(shotError)}`);
        }
      }
    }
    result.ms = Date.now() - start;
    results.push(result);
  }
  return results;
}

export function summarize(results: readonly CellResult[], baseUrl: string): string {
  return `pwa-scenarios: pass ${results.filter((r) => r.pass).length} · fail ${results.filter((r) => !r.pass && !r.blocked).length} · blocked ${results.filter((r) => Boolean(r.blocked)).length} · base ${baseUrl}`;
}
