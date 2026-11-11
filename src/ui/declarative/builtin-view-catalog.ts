import type { WidgetChromeSpec } from './spec.js';
import type { View } from '../view.js';
import { Dialog } from '../widgets/dialog.js';
import { SlashMenu, type SlashCommand } from '../widgets/slash-menu.js';
import { ContextMenu } from '../widgets/context-menu.js';
import { FileDialog, type FileDialogMode, type FileEntry } from '../widgets/file-dialog.js';
import { PermissionPrompt } from '../widgets/permission-prompt.js';
import type { ButtonStyle } from '../widgets/button.js';
import {
  RequestUserInputOverlay,
  type Question,
  type QuestionAnswer,
} from '../widgets/request-user-input-overlay.js';
import type { WidgetSpec } from './spec.js';

export interface DeclarativeViewRuntimeDeps {
  readDir?: (path: string) => FileEntry[] | Promise<FileEntry[]>;
  onDialogSubmit?: (value: unknown) => void;
  onContextPick?: (value: unknown) => void;
  onFileSubmit?: (path: string) => void;
  onPermissionSubmit?: (value: unknown, feedback?: string) => void;
  onRequestSubmit?: (answers: QuestionAnswer[]) => void;
  onCancel?: () => void;
}

export interface BuiltinDeclarativeViewDefinition {
  readonly type: string;
  readonly description: string;
  readonly configSchema: Record<string, unknown>;
  readonly createView: (spec: WidgetSpec, deps: DeclarativeViewRuntimeDeps) => View;
}

const stringValueSchema = { type: 'string' } as const;
const anyValueSchema = {} as const;

const dialogButtonSchema = {
  oneOf: [
    stringValueSchema,
    {
      type: 'object',
      properties: {
        label: stringValueSchema,
        value: anyValueSchema,
        shortcut: stringValueSchema,
        style: { type: 'string', enum: ['default', 'primary', 'danger'] },
      },
      required: ['label'],
      additionalProperties: false,
    },
  ],
} as const;

const selectOptionSchema = {
  type: 'object',
  properties: {
    value: anyValueSchema,
    label: stringValueSchema,
    shortcut: stringValueSchema,
    description: stringValueSchema,
    disabled: { type: 'boolean' },
    positive: { type: 'boolean' },
  },
  required: ['label'],
  additionalProperties: false,
} as const;

const textInputTypeSchema = {
  type: 'object',
  properties: {
    placeholder: stringValueSchema,
    initialValue: stringValueSchema,
  },
  additionalProperties: false,
} as const;

const requestQuestionSchema = {
  type: 'object',
  properties: {
    id: stringValueSchema,
    title: stringValueSchema,
    options: { type: 'array', items: selectOptionSchema },
    inputType: textInputTypeSchema,
    allowNotes: { type: 'boolean' },
    notesPlaceholder: stringValueSchema,
  },
  required: ['id', 'title'],
  additionalProperties: false,
} as const;

const intakeActionSchema = {
  type: 'object',
  properties: {
    label: stringValueSchema,
    value: anyValueSchema,
  },
  required: ['label'],
  additionalProperties: false,
} as const;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, label);
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new Error(`${label} must be a number`);
  return value;
}

function asButtonStyle(value: unknown, label: string): ButtonStyle | undefined {
  if (value === undefined) return undefined;
  if (value === 'default' || value === 'primary' || value === 'danger') return value;
  throw new Error(`${label} must be one of default|primary|danger`);
}

function chromeOf(spec: WidgetSpec): WidgetChromeSpec | undefined {
  return spec.chrome;
}

function configOf(spec: WidgetSpec): Record<string, unknown> {
  return spec.config ?? {};
}

export const builtinDeclarativeViewDefinitions: readonly BuiltinDeclarativeViewDefinition[] = [
  {
    type: 'dialog',
    description: 'dialog view wrapper',
    configSchema: {
      type: 'object',
      properties: {
        body: stringValueSchema,
        buttons: { type: 'array', items: dialogButtonSchema },
      },
      required: ['body', 'buttons'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      const buttonsRaw = cfg.buttons;
      if (!Array.isArray(buttonsRaw)) throw new Error('dialog.config.buttons must be an array');
      const buttons = buttonsRaw.map((button) => {
        if (typeof button === 'string') return { label: button, value: button };
        const obj = asObject(button, 'dialog.config.buttons[]');
        const label = asString(obj.label, 'dialog.config.buttons[].label');
        return {
          label,
          value: obj.value ?? label,
          ...(typeof obj.shortcut === 'string' ? { shortcut: obj.shortcut } : {}),
          ...(obj.style !== undefined ? { style: asButtonStyle(obj.style, 'dialog.config.buttons[].style') } : {}),
        };
      });
      return new Dialog({
        title: spec.chrome?.title ?? spec.character ?? spec.type,
        body: asString(cfg.body, 'dialog.config.body'),
        buttons,
        onSubmit: deps.onDialogSubmit ?? (() => {}),
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
  {
    type: 'permission-prompt',
    description: 'permission prompt view wrapper',
    configSchema: {
      type: 'object',
      properties: {
        title: stringValueSchema,
        body: stringValueSchema,
        choices: { type: 'array', items: selectOptionSchema },
        feedbackPlaceholder: stringValueSchema,
        feedbackMaxLength: { type: 'integer', minimum: 0 },
      },
      required: ['title', 'choices'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      const choicesRaw = cfg.choices;
      if (!Array.isArray(choicesRaw)) throw new Error('permission-prompt.config.choices must be an array');
      return new PermissionPrompt({
        title: spec.chrome?.title ?? asString(cfg.title, 'permission-prompt.config.title'),
        ...(cfg.body !== undefined ? { body: asString(cfg.body, 'permission-prompt.config.body') } : {}),
        choices: choicesRaw.map((choice) => {
          const obj = asObject(choice, 'permission-prompt.config.choices[]');
          return {
            value: obj.value ?? asString(obj.label, 'permission-prompt.config.choices[].label'),
            label: asString(obj.label, 'permission-prompt.config.choices[].label'),
            ...(asOptionalString(obj.shortcut, 'permission-prompt.config.choices[].shortcut')
              ? { shortcut: asOptionalString(obj.shortcut, 'permission-prompt.config.choices[].shortcut') }
              : {}),
            ...(asOptionalString(obj.description, 'permission-prompt.config.choices[].description')
              ? { description: asOptionalString(obj.description, 'permission-prompt.config.choices[].description') }
              : {}),
            ...(obj.positive !== undefined ? { positive: asBoolean(obj.positive) } : {}),
          };
        }),
        ...(cfg.feedbackPlaceholder !== undefined
          ? { feedbackPlaceholder: asString(cfg.feedbackPlaceholder, 'permission-prompt.config.feedbackPlaceholder') }
          : {}),
        ...(cfg.feedbackMaxLength !== undefined
          ? { feedbackMaxLength: asNumber(cfg.feedbackMaxLength, 'permission-prompt.config.feedbackMaxLength') }
          : {}),
        onSubmit: deps.onPermissionSubmit ?? (() => {}),
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
  {
    type: 'slash-menu',
    description: 'slash command picker view wrapper',
    configSchema: {
      type: 'object',
      properties: {
        title: stringValueSchema,
        commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: stringValueSchema,
              description: stringValueSchema,
              category: stringValueSchema,
            },
            required: ['name', 'description'],
            additionalProperties: false,
          },
        },
      },
      required: ['commands'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      const commandsRaw = cfg.commands;
      if (!Array.isArray(commandsRaw)) throw new Error('slash-menu.config.commands must be an array');
      const commands: SlashCommand[] = commandsRaw.map((command) => {
        const obj = asObject(command, 'slash-menu.config.commands[]');
        return {
          name: asString(obj.name, 'slash-menu.config.commands[].name'),
          description: asString(obj.description, 'slash-menu.config.commands[].description'),
          ...(typeof obj.category === 'string' ? { category: obj.category } : {}),
          onRun: () => {},
        };
      });
      return new SlashMenu({
        ...(typeof cfg.title === 'string' ? { title: cfg.title } : {}),
        commands,
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
  {
    type: 'context-menu',
    description: 'context menu view wrapper',
    configSchema: {
      type: 'object',
      properties: {
        title: stringValueSchema,
        items: { type: 'array', items: selectOptionSchema },
      },
      required: ['items'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      const itemsRaw = cfg.items;
      if (!Array.isArray(itemsRaw)) throw new Error('context-menu.config.items must be an array');
      const items = itemsRaw.map((item) => {
        if (typeof item === 'string') return { value: item, label: item };
        const obj = asObject(item, 'context-menu.config.items[]');
        const label = asString(obj.label, 'context-menu.config.items[].label');
        return {
          value: obj.value ?? label,
          label,
          ...(typeof obj.shortcut === 'string' ? { shortcut: obj.shortcut } : {}),
          ...(typeof obj.disabled === 'boolean' ? { disabled: obj.disabled } : {}),
        };
      });
      return new ContextMenu({
        ...(typeof cfg.title === 'string' ? { title: cfg.title } : {}),
        items,
        onPick: deps.onContextPick ?? (() => {}),
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
  {
    type: 'file-dialog',
    description: 'file dialog view wrapper',
    configSchema: {
      type: 'object',
      properties: {
        startDir: stringValueSchema,
        mode: { type: 'string', enum: ['open', 'save', 'dir'] },
        showHidden: { type: 'boolean' },
        defaultName: stringValueSchema,
        browseMode: { type: 'boolean' },
      },
      required: ['startDir', 'mode'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      if (!deps.readDir) throw new Error('file-dialog runtime requires deps.readDir');
      return new FileDialog({
        startDir: asString(cfg.startDir, 'file-dialog.config.startDir'),
        mode: asString(cfg.mode, 'file-dialog.config.mode') as FileDialogMode,
        readDir: deps.readDir,
        ...(cfg.showHidden !== undefined ? { showHidden: asBoolean(cfg.showHidden) } : {}),
        ...(cfg.defaultName !== undefined ? { defaultName: asString(cfg.defaultName, 'file-dialog.config.defaultName') } : {}),
        ...(cfg.browseMode !== undefined ? { browseMode: asBoolean(cfg.browseMode) } : {}),
        onSubmit: (path) => { deps.onFileSubmit?.(path); },
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
  {
    type: 'intake-review',
    description: 'intake review wrapper that routes to clarify or dialog flows',
    configSchema: {
      type: 'object',
      properties: {
        title: stringValueSchema,
        body: stringValueSchema,
        questions: { type: 'array', items: requestQuestionSchema },
        actions: { type: 'array', items: intakeActionSchema },
      },
      required: ['body'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      const title = typeof cfg.title === 'string'
        ? cfg.title
        : spec.chrome?.title ?? spec.character ?? spec.type;
      const questionsRaw = Array.isArray(cfg.questions) ? cfg.questions : [];
      if (questionsRaw.length > 0) {
        const questions: Question[] = questionsRaw.map((question) => {
          const obj = asObject(question, 'intake-review.config.questions[]');
          const built: Question = {
            id: asString(obj.id, 'intake-review.config.questions[].id'),
            title: asString(obj.title, 'intake-review.config.questions[].title'),
          };
          if (Array.isArray(obj.options)) {
            built.options = obj.options.map((option) => {
              if (typeof option === 'string') return { value: option, label: option };
              const opt = asObject(option, 'intake-review.config.questions[].options[]');
              const label = asString(opt.label, 'intake-review.config.questions[].options[].label');
              return { value: opt.value ?? label, label };
            });
          }
          if (obj.inputType !== undefined) {
            const input = asObject(obj.inputType, 'intake-review.config.questions[].inputType');
            built.inputType = {
              ...(input.placeholder !== undefined ? { placeholder: asString(input.placeholder, 'intake-review.config.questions[].inputType.placeholder') } : {}),
              ...(input.initialValue !== undefined ? { initialValue: asString(input.initialValue, 'intake-review.config.questions[].inputType.initialValue') } : {}),
            };
          }
          if (obj.allowNotes !== undefined) built.allowNotes = asBoolean(obj.allowNotes);
          if (obj.notesPlaceholder !== undefined) built.notesPlaceholder = asString(obj.notesPlaceholder, 'intake-review.config.questions[].notesPlaceholder');
          return built;
        });
        return new RequestUserInputOverlay({
          questions,
          allowBackNav: false,
          onSubmit: deps.onRequestSubmit ?? (() => {}),
          onCancel: deps.onCancel,
          chromeSpec: { ...(chromeOf(spec) ?? {}), title },
        });
      }
      const actionsRaw = Array.isArray(cfg.actions) ? cfg.actions : [];
      const buttons = actionsRaw.length > 0
        ? actionsRaw.map((action) => {
            const obj = asObject(action, 'intake-review.config.actions[]');
            const label = asString(obj.label, 'intake-review.config.actions[].label');
            return {
              label,
              value: obj.value ?? label,
            };
          })
        : [{ label: 'Close', value: 'close' }];
      return new Dialog({
        title,
        body: asString(cfg.body, 'intake-review.config.body'),
        buttons,
        onSubmit: deps.onDialogSubmit ?? (() => {}),
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
  {
    type: 'request-user-input-overlay',
    description: 'multi-question ask-user overlay view wrapper',
    configSchema: {
      type: 'object',
      properties: {
        allowBackNav: { type: 'boolean' },
        questions: { type: 'array', items: requestQuestionSchema },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    createView: (spec, deps) => {
      const cfg = configOf(spec);
      const questionsRaw = cfg.questions;
      if (!Array.isArray(questionsRaw)) throw new Error('request-user-input-overlay.config.questions must be an array');
      const questions: Question[] = questionsRaw.map((question) => {
        const obj = asObject(question, 'request-user-input-overlay.config.questions[]');
        const built: Question = {
          id: asString(obj.id, 'request-user-input-overlay.config.questions[].id'),
          title: asString(obj.title, 'request-user-input-overlay.config.questions[].title'),
        };
        if (Array.isArray(obj.options)) {
          built.options = obj.options.map((option) => {
            if (typeof option === 'string') return { value: option, label: option };
            const opt = asObject(option, 'request-user-input-overlay.config.questions[].options[]');
            const label = asString(opt.label, 'request-user-input-overlay.config.questions[].options[].label');
            return { value: opt.value ?? label, label };
          });
        }
        if (obj.inputType !== undefined) {
          const input = asObject(obj.inputType, 'request-user-input-overlay.config.questions[].inputType');
          built.inputType = {
            ...(input.placeholder !== undefined ? { placeholder: asString(input.placeholder, 'request-user-input-overlay.config.questions[].inputType.placeholder') } : {}),
            ...(input.initialValue !== undefined ? { initialValue: asString(input.initialValue, 'request-user-input-overlay.config.questions[].inputType.initialValue') } : {}),
          };
        }
        if (obj.allowNotes !== undefined) built.allowNotes = asBoolean(obj.allowNotes);
        if (obj.notesPlaceholder !== undefined) built.notesPlaceholder = asString(obj.notesPlaceholder, 'request-user-input-overlay.config.questions[].notesPlaceholder');
        return built;
      });
      return new RequestUserInputOverlay({
        questions,
        allowBackNav: asBoolean(cfg.allowBackNav),
        onSubmit: deps.onRequestSubmit ?? (() => {}),
        onCancel: deps.onCancel,
        ...(chromeOf(spec) ? { chromeSpec: chromeOf(spec) } : {}),
      });
    },
  },
] as const;
