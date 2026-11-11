import { describe, test, expect } from 'bun:test';
import { BoxDecoration } from '../../../src/ui/attributes/index.js';
import {
  DeclarativeCommandBuilder,
  DeclarativeCommandSpec,
  DeclarativeDialogButtonBuilder,
  DeclarativeDialogButtonSpec,
  DeclarativeIntakeActionBuilder,
  DeclarativeIntakeActionSpec,
  DeclarativeQuestionSpec,
  DeclarativeQuestionBuilder,
  WidgetBuilder,
  buildWidgetSpecs,
  command,
  dialogButton,
  contextMenuWidget,
  dialogWidget,
  fileDialogWidget,
  intakeReviewWidget,
  intakeAction,
  listWidget,
  logWidget,
  option,
  panelWidget,
  permissionPromptWidget,
  question,
  requestUserInputWidget,
  slashMenuWidget,
  textAreaWidget,
  toastStackWidget,
  widget,
  windowWidget,
} from '../../../src/ui/declarative/index.js';

describe('WidgetBuilder', () => {
  test('builds extended declarative widget spec with fluent chaining', () => {
    const spec = new WidgetBuilder('log')
      .withId('log-1')
      .withCharacter('Telemetry')
      .withConfig({ lines: ['hello'] })
      .setStyle({
        className: 'card',
        variant: 'raised',
        decoration: new BoxDecoration({ color: 'surface' }),
      })
      .setToken('tone', 'positive')
      .setStateStyle('hovered', { className: 'card-hover' })
      .setChrome({ variant: 'window', title: 'Telemetry', footer: 'Esc close' })
      .setChromeTitleAlign('center')
      .showCloseButton()
      .setMotion({ preset: 'fade', durationMs: 180 })
      .animateEnter({ preset: 'slide-up', durationMs: 160 })
      .animateHover({ preset: 'pulse', durationMs: 90 })
      .onHover('show-tooltip', { id: 'telemetry' })
      .onClick('open-log')
      .onKey('enter', 'open-log')
      .withChild(widget('list').withId('child-list').withConfig({ items: ['a'] }))
      .build();

    expect(spec.id).toBe('log-1');
    expect(spec.character).toBe('Telemetry');
    expect(spec.style?.className).toBe('card');
    expect(spec.style?.tokens?.tone).toBe('positive');
    expect(spec.style?.states?.hovered?.className).toBe('card-hover');
    expect(spec.decoration).toBeInstanceOf(BoxDecoration);
    expect(spec.chrome?.title).toBe('Telemetry');
    expect(spec.chrome?.titleAlign).toBe('center');
    expect(spec.chrome?.showClose).toBe(true);
    expect(spec.motion?.preset).toBe('fade');
    expect(spec.motion?.enter?.preset).toBe('slide-up');
    expect(spec.motion?.hover?.preset).toBe('pulse');
    expect(spec.interactions?.key?.[0]?.key).toBe('enter');
    expect(spec.children?.[0]?.type).toBe('list');
  });

  test('can render fluent spec back to yaml', async () => {
    const yaml = await widget('log')
      .withCharacter('Audit')
      .setChromeTitle('Audit')
      .setFooter('Ctrl+P')
      .onClick('open-audit')
      .buildYAML();

    expect(yaml).toContain('widget: log');
    expect(yaml).toContain('character: Audit');
    expect(yaml).toContain('title: Audit');
    expect(yaml).toContain('action: open-audit');
  });

  test('role-specific builders apply shared chrome defaults', () => {
    const windowSpec = windowWidget('log', 'Telemetry').build();
    const dialogSpec = dialogWidget('dialog', 'Approve').build();
    const panelSpec = panelWidget('list', 'Queue').build();
    const intakeSpec = intakeReviewWidget('Review intake').build();

    expect(windowSpec.chrome).toMatchObject({ variant: 'window', title: 'Telemetry', showBorder: true });
    expect(dialogSpec.chrome).toMatchObject({ variant: 'dialog', title: 'Approve', showBorder: true });
    expect(panelSpec.chrome).toMatchObject({ variant: 'panel', title: 'Queue', showBorder: true });
    expect(intakeSpec.chrome).toMatchObject({ variant: 'dialog', title: 'Review intake', showBorder: true });
  });

  test('family-specific builders reduce config dumping', () => {
    const dialogButtons: readonly (DeclarativeDialogButtonSpec | DeclarativeDialogButtonBuilder)[] = [
      dialogButton('Approve').setShortcut('a'),
      dialogButton('Deny', 'deny'),
    ];
    const dialogSpec = dialogWidget('dialog', 'Approve patch?')
      .setBody('Replace 14 lines in dashboard runtime')
      .setButtons(dialogButtons)
      .build();
    const listSpec = listWidget('Queue')
      .setItems(['crawl docs', 'switch model'])
      .setIcons(['•', '•'])
      .build();
    const logSpec = logWidget('Telemetry')
      .setLines(['> hello', '> world'])
      .build();
    const toastSpec = toastStackWidget('Toasts')
      .setPlacement('top-right')
      .setItems([
        { text: 'Saved widget spec', kind: 'success' },
        { text: 'Theme switched', kind: 'info' },
      ])
      .build();
    const textAreaSpec = textAreaWidget('Notes')
      .setText('line one\nline two')
      .setReadOnly()
      .setWrap()
      .setMaxLength(400)
      .build();
    const permissionSpec = permissionPromptWidget('Approval prompt')
      .setBody('rm -rf /tmp/example')
      .setChoices([
        option('Allow once', 'allow').setShortcut('a').setPositive(),
        option('Deny', 'deny').setShortcut('d'),
      ])
      .setFeedbackPrompt('Why?', 200)
      .build();
    const commands: readonly (DeclarativeCommandSpec | DeclarativeCommandBuilder)[] = [
      command('/status', 'Print workspace status').setCategory('core'),
      command('/switch', 'Switch active model').setCategory('model'),
    ];
    const slashSpec = slashMenuWidget('Commands')
      .setCommands([
        ...commands,
      ])
      .build();
    const contextSpec = contextMenuWidget('Actions')
      .setItems([
        option('Open', 'open').setShortcut('o'),
        option('Delete', 'delete').setDisabled(),
      ])
      .build();
    const fileSpec = fileDialogWidget('Save artifact')
      .setStartDir('/')
      .setMode('save')
      .setDefaultName('draft.md')
      .setBrowseMode()
      .build();
    const questions: readonly (DeclarativeQuestionSpec | DeclarativeQuestionBuilder)[] = [
      question('scope', 'Scope?').setOptions([option('Single file', 's')]),
      question('notes', 'Notes?').setInputType({ placeholder: 'Optional' }).allowNotes(),
    ];
    const intakeActions: readonly (DeclarativeIntakeActionSpec | DeclarativeIntakeActionBuilder)[] = [
      intakeAction('Apply now', { kind: 'decide-apply-now' }),
      intakeAction('Keep in backlog', { kind: 'decide-backlog-only' }),
    ];
    const requestSpec = requestUserInputWidget('Ask user')
      .allowBackNav()
      .setQuestions(questions)
      .build();
    const intakeSpec = intakeReviewWidget('Review intake')
      .setBody('Intake summary')
      .setActions(intakeActions)
      .build();

    expect(dialogSpec.config).toMatchObject({
      body: 'Replace 14 lines in dashboard runtime',
      buttons: [
        { label: 'Approve', shortcut: 'a', value: 'Approve' },
        { label: 'Deny', value: 'deny' },
      ],
    });
    expect(listSpec.type).toBe('list');
    expect(listSpec.chrome).toMatchObject({ variant: 'panel', title: 'Queue' });
    expect(listSpec.config).toMatchObject({
      items: ['crawl docs', 'switch model'],
      icons: ['•', '•'],
    });
    expect(logSpec.type).toBe('log');
    expect(logSpec.chrome).toMatchObject({ variant: 'window', title: 'Telemetry' });
    expect(logSpec.config).toMatchObject({
      lines: ['> hello', '> world'],
    });
    expect(toastSpec.type).toBe('toast-stack');
    expect(toastSpec.chrome).toMatchObject({ variant: 'panel', title: 'Toasts' });
    expect(toastSpec.config).toMatchObject({
      placement: 'top-right',
      items: [
        { text: 'Saved widget spec', kind: 'success' },
        { text: 'Theme switched', kind: 'info' },
      ],
    });
    expect(textAreaSpec.type).toBe('text-area');
    expect(textAreaSpec.chrome).toMatchObject({ variant: 'panel', title: 'Notes' });
    expect(textAreaSpec.config).toMatchObject({
      text: 'line one\nline two',
      readOnly: true,
      wrap: true,
      maxLength: 400,
    });
    expect(permissionSpec.config).toMatchObject({
      title: 'Approval prompt',
      choices: [
        { label: 'Allow once', value: 'allow', shortcut: 'a', positive: true },
        { label: 'Deny', value: 'deny', shortcut: 'd' },
      ],
      feedbackPlaceholder: 'Why?',
      feedbackMaxLength: 200,
    });
    expect(slashSpec.config).toMatchObject({
      title: 'Commands',
      commands: [
        { name: '/status', description: 'Print workspace status', category: 'core' },
        { name: '/switch', description: 'Switch active model', category: 'model' },
      ],
    });
    expect(contextSpec.config).toMatchObject({
      title: 'Actions',
      items: [
        { label: 'Open', value: 'open', shortcut: 'o' },
        { label: 'Delete', value: 'delete', disabled: true },
      ],
    });
    expect(fileSpec.config).toMatchObject({
      startDir: '/',
      mode: 'save',
      defaultName: 'draft.md',
      browseMode: true,
    });
    expect(requestSpec.config).toMatchObject({
      allowBackNav: true,
      questions: [
        { id: 'scope', title: 'Scope?', options: [{ label: 'Single file', value: 's' }] },
        { id: 'notes', title: 'Notes?', inputType: { placeholder: 'Optional' }, allowNotes: true },
      ],
    });
    expect(intakeSpec.config).toMatchObject({
      title: 'Review intake',
      body: 'Intake summary',
      actions: [
        { label: 'Apply now', value: { kind: 'decide-apply-now' } },
        { label: 'Keep in backlog', value: { kind: 'decide-backlog-only' } },
      ],
    });
  });

  test('fluent option and question builders clone authored specs', () => {
    const selectOption = option('Allow once', 'allow')
      .setShortcut('a')
      .setDescription('Run this command once')
      .setPositive();
    const questionSpec = question('scope', 'Pick a scope')
      .setOptions([selectOption])
      .allowNotes('Reason')
      .build();

    expect(selectOption.build()).toEqual({
      label: 'Allow once',
      value: 'allow',
      shortcut: 'a',
      description: 'Run this command once',
      positive: true,
    });
    expect(questionSpec).toEqual({
      id: 'scope',
      title: 'Pick a scope',
      options: [{
        label: 'Allow once',
        value: 'allow',
        shortcut: 'a',
        description: 'Run this command once',
        positive: true,
      }],
      allowNotes: true,
      notesPlaceholder: 'Reason',
    });
  });

  test('fluent command builder clones authored specs', () => {
    const slashCommand = command('/status', 'Print workspace status').setCategory('core');
    expect(slashCommand.build()).toEqual({
      name: '/status',
      description: 'Print workspace status',
      category: 'core',
    });
  });

  test('fluent dialog button and intake action builders clone authored specs', () => {
    const approve = dialogButton('Approve').setShortcut('a').setStyle('primary');
    const backlog = intakeAction('Keep in backlog', { kind: 'decide-backlog-only' });

    expect(approve.build()).toEqual({
      label: 'Approve',
      shortcut: 'a',
      style: 'primary',
    });
    expect(backlog.build()).toEqual({
      label: 'Keep in backlog',
      value: { kind: 'decide-backlog-only' },
    });
  });

  test('buildWidgetSpecs materializes builder-authored node arrays', () => {
    const specs = buildWidgetSpecs([
      logWidget('Telemetry').setLines(['> hello']),
      textAreaWidget('Notes').setText('draft').setReadOnly(),
    ]);

    expect(specs).toEqual([
      {
        type: 'log',
        chrome: { variant: 'window', title: 'Telemetry', showBorder: true },
        config: { lines: ['> hello'] },
      },
      {
        type: 'text-area',
        chrome: { variant: 'panel', title: 'Notes', showBorder: true },
        config: { text: 'draft', readOnly: true },
      },
    ]);
  });
});
