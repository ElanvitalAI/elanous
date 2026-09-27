import { createCdpClient, createCdpClientFromEndpoint, type CdpClient } from '../../../src/browser-cdp/client.js';
import type { PageDriver } from './runner.js';

export const VIEWPORT = { width: 1280, height: 800 } as const;

/** Owns its Chrome process and an independent page target; never attaches to a user's browser. */
export async function createCdpPageDriver(port: number, headed = false, baseUrl: string): Promise<PageDriver & { close(): Promise<void> }> {
  const browser = await createCdpClient({ port, headless: !headed, url: 'about:blank' });
  let page: CdpClient;
  try {
    // A page-level WebSocket is required for Runtime/Page/Input domains. The spawned
    // browser's /json/version endpoint is browser-level, not page-level.
    page = await createCdpClientFromEndpoint(port);
  } catch (error) {
    await browser.close();
    throw error;
  }
  const send = async (method: string, params: Record<string, unknown>): Promise<void> => {
    if (!page.send) throw new Error(`CDP ${method} is unavailable`);
    await page.send(method, params);
  };
  // 헤드리스 기본 창(약 756×469)은 실제 기기보다 작아 터미널이 한 줄로 눌린다(2026-09-27 실측) — 데스크톱 크기로 고정한다.
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  return {
    async llmCallCursor() {
      // Same daemon's log store, not the runner's own or any federated store.
      const url = `${baseUrl}/v1/logs?category=llm.stream&event=consume-start&limit=1`;
      const response = await fetch(url, { headers: { Origin: baseUrl }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`LLM log cursor unavailable: HTTP ${response.status}`);
      const body = await response.json() as { ok?: boolean; logs?: Array<{ id?: unknown }> };
      if (body.ok !== true || !Array.isArray(body.logs)) throw new Error('LLM log cursor unavailable: invalid response');
      const id = body.logs.length === 0 ? 0 : body.logs[0]?.id;
      if (!Number.isSafeInteger(id) || Number(id) < 0) throw new Error('LLM log cursor unavailable: invalid ID');
      return Number(id);
    },
    async goto(url) {
      const result = await page.navigate(url);
      if (result.errorText) throw new Error(`navigate ${url}: ${result.errorText}`);
    },
    evaluate: (expression) => page.evaluate(expression),
    insertText: (text) => send('Input.insertText', { text }),
    async press(key) {
      if (key !== 'Enter') throw new Error(`unsupported key: ${key}`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    },
    async click(selector) {
      const point = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`) as { x: number; y: number } | null;
      if (!point) throw new Error(`no-selector (${selector})`);
      if (page.click) await page.click(point);
      else {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      }
    },
    screenshot: () => page.screenshot({ format: 'png' }),
    async close() {
      try { await page.close(); } finally { await browser.close(); }
    },
  };
}
