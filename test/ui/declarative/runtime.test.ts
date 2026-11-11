import { describe, expect, test } from 'bun:test';
import {
  createDeclarativeRuntimeArtifact,
  resolveDeclarativeRuntimeSupport,
  dialogWidget,
  permissionPromptWidget,
  option,
  type WidgetSpec,
} from '../../../src/ui/declarative/index.js';

describe('declarative runtime support', () => {
  test('reports view and widget capabilities independently', () => {
    const markdown = resolveDeclarativeRuntimeSupport(
      { type: 'markdown' },
      { host: { hasType: (type) => type === 'markdown' } },
    );
    expect(markdown).toMatchObject({
      type: 'markdown',
      supportsView: false,
      supportsWidget: true,
      preferred: 'widget',
    });
  });

  test('honors preferred runtime when both are available', () => {
    const spec: WidgetSpec = {
      type: 'dialog',
      chrome: { title: 'Approve patch?', variant: 'dialog' },
      config: {
        body: 'Replace 14 lines',
        buttons: ['Approve', 'Deny'],
      },
    };
    const host = { hasType: (type: string) => type === 'dialog' };

    const support = resolveDeclarativeRuntimeSupport(spec, { host, prefer: 'widget' });
    expect(support.kinds).toEqual(['view', 'widget']);
    expect(support.preferred).toBe('widget');

    const artifact = createDeclarativeRuntimeArtifact(spec, { host, prefer: 'widget' });
    expect(artifact.kind).toBe('widget');
    if (artifact.kind !== 'widget') throw new Error('expected widget runtime');
    expect(artifact.spawnInput).toMatchObject({
      type: 'dialog',
      character: 'Approve patch?',
    });
  });

  test('creates LC views from the same runtime artifact contract', () => {
    const artifact = createDeclarativeRuntimeArtifact(
      permissionPromptWidget('Approval prompt')
        .setChoices([
          option('Allow once', 'allow').setPositive(),
          option('Deny', 'deny'),
        ]),
    );
    expect(artifact.kind).toBe('view');
    if (artifact.kind !== 'view') throw new Error('expected view runtime');
    expect(typeof artifact.view.draw).toBe('function');
  });

  test('accepts fluent builders directly for widget runtime support', () => {
    const host = { hasType: (type: string) => type === 'dialog' };
    const builder = dialogWidget('dialog', 'Approve patch?')
      .setBody('Replace 14 lines')
      .setButtons(['Approve', 'Deny']);

    const support = resolveDeclarativeRuntimeSupport(builder, { host, prefer: 'widget' });
    expect(support).toMatchObject({
      type: 'dialog',
      supportsView: true,
      supportsWidget: true,
      preferred: 'widget',
    });
  });
});
