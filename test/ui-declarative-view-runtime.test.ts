import { describe, expect, test } from 'bun:test';
import { Printer } from '../src/ui/printer.js';
import { stripAnsi } from '../src/tui.js';
import type { Size } from '../src/ui/view.js';
import {
  canCreateDeclarativeView,
  createDeclarativeView,
  registerDeclarativeViewDefinition,
  type WidgetSpec,
} from '../src/ui/declarative/index.js';
import type { FileEntry } from '../src/ui/widgets/file-dialog.js';
import { _resetWidgetSchemaRegistryForTest, hasWidgetSchema } from '../src/ui/declarative/schema.js';

function render(spec: WidgetSpec, size: Size = { width: 40, height: 8 }): string[] {
  const view = createDeclarativeView(spec, {
    readDir: (path: string): FileEntry[] => (
      path === '/'
        ? [{ name: 'draft.md', isDirectory: false }]
        : []
    ),
  });
  const p = Printer.create({ width: size.width, height: size.height, focused: true });
  view.layout(size);
  view.takeFocus('front');
  view.draw(p);
  return p.lines().map(stripAnsi);
}

describe('declarative view runtime', () => {
  test('reports which spec types have runtime factories', () => {
    expect(canCreateDeclarativeView({ type: 'dialog' })).toBe(true);
    expect(canCreateDeclarativeView({ type: 'intake-review' })).toBe(true);
    expect(canCreateDeclarativeView({ type: 'permission-prompt' })).toBe(true);
    expect(canCreateDeclarativeView({ type: 'request-user-input-overlay' })).toBe(true);
    expect(canCreateDeclarativeView({ type: 'unknown-type' })).toBe(false);
  });

  test('materializes dialog body and buttons from declarative spec', () => {
    const lines = render({
      type: 'dialog',
      chrome: { title: 'Approve patch?', showClose: true, variant: 'dialog' },
      config: {
        body: 'Replace 14 lines in dashboard runtime',
        buttons: ['Approve', 'Deny'],
      },
    }, { width: 40, height: 6 });
    const joined = lines.join('\n');
    expect(joined).toContain('Approve patch?');
    expect(joined).toContain('Replace 14 lines');
    expect(joined).toContain('Approve');
  });

  test('materializes select-family wrappers from declarative specs', () => {
    const slashLines = render({
      type: 'slash-menu',
      chrome: { title: 'Commands', showClose: false, variant: 'panel' },
      config: {
        title: '/ commands',
        commands: [
          { name: '/status', description: 'Print workspace status', category: 'core' },
          { name: '/switch', description: 'Switch the active model', category: 'model' },
        ],
      },
    });
    expect(slashLines.join('\n')).toContain('Commands');
    expect(slashLines.join('\n')).toContain('/status');

    const menuLines = render({
      type: 'context-menu',
      chrome: { title: 'Actions', showClose: false, variant: 'panel' },
      config: {
        items: [
          { value: 'open', label: 'Open' },
          { value: 'delete', label: 'Delete', disabled: true },
        ],
      },
    });
    expect(menuLines.join('\n')).toContain('Actions');
    expect(menuLines.join('\n')).toContain('Open');

    const permissionLines = render({
      type: 'permission-prompt',
      chrome: { title: 'Approval prompt', showClose: true, variant: 'dialog' },
      config: {
        title: 'Approve destructive Bash?',
        body: 'rm -rf /tmp/example',
        choices: [
          { value: 'allow', label: 'Allow once', shortcut: 'a', positive: true },
          { value: 'deny', label: 'Deny', shortcut: 'd' },
        ],
      },
    });
    expect(permissionLines.join('\n')).toContain('Approval prompt');
    expect(permissionLines.join('\n')).toContain('Allow once');
  });

  test('materializes file-dialog and request-user-input-overlay from declarative specs', () => {
    const fileLines = render({
      type: 'file-dialog',
      chrome: { title: 'Save artifact', showClose: true, variant: 'window' },
      config: { startDir: '/', mode: 'save', defaultName: 'draft.md' },
    });
    expect(fileLines.join('\n')).toContain('Save artifact');

    const askLines = render({
      type: 'request-user-input-overlay',
      chrome: { title: 'Ask user', showClose: true, variant: 'dialog' },
      config: {
        allowBackNav: true,
        questions: [
          {
            id: 'scope',
            title: 'Scope?',
            options: [{ value: 's', label: 'Single file' }],
          },
          {
            id: 'notes',
            title: 'Notes?',
            inputType: { placeholder: 'Optional' },
            allowNotes: true,
          },
        ],
      },
    });
    expect(askLines.join('\n')).toContain('Ask user');
    expect(askLines.join('\n')).toContain('Scope?');
  });

  test('materializes intake-review into dialog or clarify view flows', () => {
    const reviewLines = render({
      type: 'intake-review',
      chrome: { title: 'Review intake · intake-1', showClose: true, variant: 'dialog' },
      config: {
        title: 'Review intake · intake-1',
        body: 'Intake: intake-1\nState: review-ready\nTitle: compare two repos',
        actions: [
          { label: 'Apply now', value: { kind: 'decide-apply-now', intakeId: 'intake-1' } },
          { label: 'Keep in backlog', value: { kind: 'decide-backlog-only', intakeId: 'intake-1' } },
        ],
      },
    });
    expect(reviewLines.join('\n')).toContain('Review intake');
    expect(reviewLines.join('\n')).toContain('Apply now');

    const clarifyLines = render({
      type: 'intake-review',
      chrome: { title: 'Clarify intake · intake-1', showClose: true, variant: 'dialog' },
      config: {
        title: 'Clarify intake · intake-1',
        body: 'Need one clarification',
        questions: [
          {
            id: 'q1',
            title: 'Which repo should lead?',
            inputType: { placeholder: 'Add the missing context' },
          },
        ],
      },
    });
    expect(clarifyLines.join('\n')).toContain('Clarify intake');
    expect(clarifyLines.join('\n')).toContain('Which repo should lead?');
  });

  test('custom declarative view definition wires runtime and schema together', () => {
    _resetWidgetSchemaRegistryForTest();
    const dispose = registerDeclarativeViewDefinition({
      type: 'custom-inline-note',
      description: 'custom note',
      configSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      createView: (spec) => ({
        draw(p) { p.text(0, 0, String(spec.config?.text ?? '')); },
        onEvent() { return { kind: 'ignored' } as const; },
        layout() {},
        requiredSize(c) { return c; },
        takeFocus() { return false; },
      }),
    });
    expect(canCreateDeclarativeView({ type: 'custom-inline-note' })).toBe(true);
    expect(hasWidgetSchema('custom-inline-note')).toBe(true);
    const lines = render({
      type: 'custom-inline-note',
      config: { text: 'hello custom' },
    }, { width: 20, height: 2 });
    expect(lines.join('\n')).toContain('hello custom');
    dispose();
    expect(hasWidgetSchema('custom-inline-note')).toBe(false);
    expect(canCreateDeclarativeView({ type: 'custom-inline-note' })).toBe(false);
  });
});
