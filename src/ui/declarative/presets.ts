import {
  buildWidgetSpec,
  buildWidgetSpecs,
  dialogButton,
  requestUserInputWidget,
  dialogWidget,
  listWidget,
  logWidget,
  option,
  question,
  textAreaWidget,
  toastStackWidget,
  type DeclarativeWidgetNode,
} from './builder.js';
import { encodeWidgetTree } from './encode.js';
import type { WidgetSpec } from './spec.js';

export interface WidgetLabPreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly build: () => readonly DeclarativeWidgetNode[];
}

function stringifyTreeSync(tree: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('yaml') as { stringify(v: unknown): string };
  return mod.stringify(tree);
}

const PRESETS: readonly WidgetLabPreset[] = [
  {
    id: 'telemetry-stack',
    title: 'Telemetry Stack',
    description: 'window chrome + footer + click interaction',
    build: () => [
      logWidget('Telemetry').withId('telemetry').withCharacter('Telemetry')
        .setFooter('Ctrl+P preview')
        .setClassName('card')
        .setVariant('raised')
        .setToken('tone', 'glass')
        .animateEnter({ preset: 'fade', durationMs: 180 })
        .onClick('open-log')
        .setLines(['> hello', '> world']),
      listWidget('Queue').withId('queue').withCharacter('Queue')
        .setFooter('j/k navigate')
        .animateEnter({ preset: 'slide-up', durationMs: 220 })
        .setItems(['crawl docs', 'switch model', 'sync vault']),
    ],
  },
  {
    id: 'approval-dialog',
    title: 'Approval Dialog',
    description: 'dialog chrome + focus motion + key interaction',
    build: () => [
      dialogWidget('dialog', 'Approve patch?').withId('approval').withCharacter('Approval')
        .setChromeTitleAlign('center')
        .showCloseButton(true)
        .setFooter('Enter approve · Esc cancel')
        .animateEnter({ preset: 'scale-in', durationMs: 160 })
        .animateFocus({ preset: 'pulse', durationMs: 120 })
        .onKey('enter', 'approve-patch')
        .setBody('Replace 14 lines in dashboard runtime')
        .setButtons([
          dialogButton('Approve').setShortcut('a').setStyle('primary'),
          dialogButton('Deny', 'deny').setShortcut('d'),
        ]),
    ],
  },
  {
    id: 'notes-panel',
    title: 'Notes Panel',
    description: 'multi-line text panel authored through text-area builder',
    build: () => [
      textAreaWidget('Notes').withId('notes').withCharacter('Notes')
        .setFooter('PgUp/PgDn scroll')
        .setText('Draft follow-ups:\n- verify widget host\n- align chrome defaults')
        .setReadOnly()
        .setWrap()
        .setMaxLength(800),
    ],
  },
  {
    id: 'ask-user-flow',
    title: 'Ask User Flow',
    description: 'request-user overlay authored through wrapper-family builders',
    build: () => [
      requestUserInputWidget('Ask user').withId('ask-user').withCharacter('AskUser')
        .showCloseButton(true)
        .setFooter('Tab notes · Enter submit')
        .allowBackNav()
        .setQuestions([
          question('scope', 'What scope should we ship?')
            .setOptions([
              option('Small', 'small').setDescription('This pane only'),
              option('Medium', 'medium').setDescription('Related panes'),
            ]),
          question('notes', 'Anything else to flag?')
            .setInputType({ placeholder: 'Optional notes' })
            .allowNotes(),
        ]),
    ],
  },
];

export function listWidgetLabPresets(): readonly WidgetLabPreset[] {
  return PRESETS;
}

export function getWidgetLabPreset(id: string): WidgetLabPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

export function buildWidgetLabPresetNodes(id: string): readonly DeclarativeWidgetNode[] {
  return (getWidgetLabPreset(id) ?? PRESETS[0]!).build();
}

export function buildWidgetLabPreset(id: string): readonly WidgetSpec[] {
  return buildWidgetSpecs(buildWidgetLabPresetNodes(id));
}

export function buildWidgetLabPresetYAML(id: string): string {
  return stringifyTreeSync(encodeWidgetTree(buildWidgetLabPresetNodes(id)));
}

export function buildWidgetLabPresetReferenceYAML(id: string): string {
  return stringifyTreeSync({ preset: id });
}

export function cycleWidgetLabPreset(current: string | undefined, dir: 1 | -1 = 1): string {
  if (PRESETS.length === 0) return 'telemetry-stack';
  const idx = current ? PRESETS.findIndex((preset) => preset.id === current) : 0;
  const currentIdx = idx >= 0 ? idx : 0;
  const next = (currentIdx + dir + PRESETS.length) % PRESETS.length;
  return PRESETS[next]!.id;
}
