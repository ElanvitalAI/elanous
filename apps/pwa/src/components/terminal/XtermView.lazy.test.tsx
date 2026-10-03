import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { ReactElement } from 'react';

const requirePwa = createRequire(import.meta.url);
const source = readFileSync(new URL('./XtermView.lazy.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

type TestElement = ReactElement<{
  role?: string;
  className?: string;
  children?: unknown;
  type?: string;
  onClick?: () => void;
}>;

type DynamicOptions = {
  ssr: boolean;
  loading: (state: { error?: Error | null; isLoading?: boolean; retry?: () => void }) => TestElement;
};

function fixture() {
  const realXtermView = () => null;
  let xtermImports = 0;
  let loader!: () => Promise<typeof realXtermView>;
  let options!: DynamicOptions;
  const dynamicComponent = () => null;
  const module = { exports: {} as { XtermViewLazy: (props: Record<string, unknown>) => ReactElement<Record<string, unknown>> } };
  const imports = (specifier: string) => {
    if (specifier === 'next/dynamic') {
      return { __esModule: true, default: (load: typeof loader, opts: DynamicOptions) => {
        loader = load;
        options = opts;
        return dynamicComponent;
      } };
    }
    if (specifier === './XtermView') { xtermImports += 1; return { XtermView: realXtermView }; }
    return requirePwa(specifier);
  };
  new Function('require', 'module', 'exports', compiled)(imports, module, module.exports);
  return { ...module.exports, loader: () => loader(), options: () => options, xtermImports: () => xtermImports, dynamicComponent };
}

test('loads only the XtermView chunk on demand with SSR disabled and forwards all props', async () => {
  const { XtermViewLazy, loader, options, xtermImports, dynamicComponent } = fixture();
  expect(source.startsWith("'use client';")).toBe(true);
  expect(options().ssr).toBe(false);
  expect(xtermImports()).toBe(0);

  const onForeignInputActivity = () => {};
  const props = { sessionId: 'session-a', terminalId: 'terminal-b', clearRequest: 3, readOnly: true, onForeignInputActivity };
  const view = XtermViewLazy(props);
  expect(view.type).toBe(dynamicComponent);
  expect(view.props).toEqual(props);
  expect(view.props.onForeignInputActivity).toBe(onForeignInputActivity);
  expect(xtermImports()).toBe(0);
  expect((await loader()).name).toBe('realXtermView');
  expect(xtermImports()).toBe(1);
});

test('loading and failed chunks occupy the terminal pane; retry is actionable', () => {
  const { options } = fixture();
  const loading = options().loading({ isLoading: true });
  expect(loading.props.role).toBe('status');
  expect(loading.props.className).toContain('h-full');
  expect(loading.props.className).toContain('w-full');
  expect(loading.props.className).toContain('bg-[#0d0c08]');
  expect(loading.props.children).toBe('터미널 연결 중…');

  let retries = 0;
  const failed = options().loading({ error: new Error('chunk unavailable'), retry: () => { retries += 1; } });
  expect(failed.props.role).toBe('alert');
  expect(failed.props.className).toBe(loading.props.className);
  const content = failed.props.children as TestElement;
  const [message, button] = content.props.children as [TestElement, TestElement];
  expect(message.props.children).toBe('터미널을 불러오지 못했습니다.');
  expect(button.props.children).toBe('다시 시도');
  expect(button.props.type).toBe('button');
  button.props.onClick?.();
  expect(retries).toBe(1);
});
