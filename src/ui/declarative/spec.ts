import { isObject } from '../../primitives/guards.js';
import { BoxDecoration } from '../attributes/index.js';

export type WidgetChromeVariant = 'none' | 'panel' | 'window' | 'dialog' | 'tooltip';
export type WidgetChromeAlign = 'left' | 'center' | 'right';

export type WidgetMotionPreset =
  | 'none'
  | 'fade'
  | 'slide-up'
  | 'slide-down'
  | 'scale-in'
  | 'pulse';

export type WidgetMotionEasing =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'spring';

export type WidgetStyleStateName =
  | 'default'
  | 'hovered'
  | 'focused'
  | 'pressed'
  | 'disabled'
  | 'selected';

export interface WidgetStyleStateSpec {
  readonly className?: string;
  readonly variant?: string;
  readonly tokens?: Record<string, unknown>;
}

export interface WidgetStyleSpec {
  readonly decoration?: BoxDecoration;
  readonly className?: string;
  readonly variant?: string;
  readonly tokens?: Record<string, unknown>;
  readonly states?: Partial<Record<WidgetStyleStateName, WidgetStyleStateSpec>>;
}

export interface WidgetChromeSpec {
  readonly variant?: WidgetChromeVariant;
  readonly title?: string;
  readonly titleAlign?: WidgetChromeAlign;
  readonly titleSuffix?: string;
  readonly footer?: string;
  readonly showBorder?: boolean;
  readonly showClose?: boolean;
}

export interface WidgetMotionPhaseSpec {
  readonly preset?: WidgetMotionPreset;
  readonly durationMs?: number;
  readonly delayMs?: number;
  readonly easing?: WidgetMotionEasing;
}

export interface WidgetMotionSpec extends WidgetMotionPhaseSpec {
  readonly enter?: WidgetMotionPhaseSpec;
  readonly exit?: WidgetMotionPhaseSpec;
  readonly hover?: WidgetMotionPhaseSpec;
  readonly focus?: WidgetMotionPhaseSpec;
}

export interface WidgetInteractionHandlerSpec {
  readonly action: string;
  readonly target?: string;
  readonly payload?: Record<string, unknown>;
}

export interface WidgetKeyInteractionSpec extends WidgetInteractionHandlerSpec {
  readonly key: string;
}

export interface WidgetInteractionSpec {
  readonly hover?: WidgetInteractionHandlerSpec | readonly WidgetInteractionHandlerSpec[];
  readonly click?: WidgetInteractionHandlerSpec | readonly WidgetInteractionHandlerSpec[];
  readonly focus?: WidgetInteractionHandlerSpec | readonly WidgetInteractionHandlerSpec[];
  readonly blur?: WidgetInteractionHandlerSpec | readonly WidgetInteractionHandlerSpec[];
  readonly key?: readonly WidgetKeyInteractionSpec[];
}

export interface WidgetSpec {
  readonly type: string;
  readonly id?: string;
  readonly character?: string;
  readonly config?: Record<string, unknown>;
  readonly decoration?: BoxDecoration;
  readonly style?: WidgetStyleSpec;
  readonly chrome?: WidgetChromeSpec;
  readonly motion?: WidgetMotionSpec;
  readonly interactions?: WidgetInteractionSpec;
  readonly children?: readonly WidgetSpec[];
}

function cleanObject<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as T;
}

export const widgetStyleStateSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    className: { type: 'string' },
    variant: { type: 'string' },
    tokens: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const widgetStyleSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    decoration: BoxDecoration.schema(),
    className: { type: 'string' },
    variant: { type: 'string' },
    tokens: { type: 'object', additionalProperties: true },
    states: {
      type: 'object',
      properties: {
        default: widgetStyleStateSchema,
        hovered: widgetStyleStateSchema,
        focused: widgetStyleStateSchema,
        pressed: widgetStyleStateSchema,
        disabled: widgetStyleStateSchema,
        selected: widgetStyleStateSchema,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const widgetChromeSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    variant: { type: 'string', enum: ['none', 'panel', 'window', 'dialog', 'tooltip'] },
    title: { type: 'string' },
    titleAlign: { type: 'string', enum: ['left', 'center', 'right'] },
    titleSuffix: { type: 'string' },
    footer: { type: 'string' },
    showBorder: { type: 'boolean' },
    showClose: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const widgetMotionPhaseSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    preset: {
      type: 'string',
      enum: ['none', 'fade', 'slide-up', 'slide-down', 'scale-in', 'pulse'],
    },
    durationMs: { type: 'integer', minimum: 0 },
    delayMs: { type: 'integer', minimum: 0 },
    easing: {
      type: 'string',
      enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring'],
    },
  },
  additionalProperties: false,
};

export const widgetMotionSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    preset: { type: 'string', enum: ['none', 'fade', 'slide-up', 'slide-down', 'scale-in', 'pulse'] },
    durationMs: { type: 'integer', minimum: 0 },
    delayMs: { type: 'integer', minimum: 0 },
    easing: { type: 'string', enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring'] },
    enter: widgetMotionPhaseSchema,
    exit: widgetMotionPhaseSchema,
    hover: widgetMotionPhaseSchema,
    focus: widgetMotionPhaseSchema,
  },
  additionalProperties: false,
};

export const widgetInteractionHandlerSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    target: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
  },
  required: ['action'],
  additionalProperties: false,
};

export const widgetKeyInteractionSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    action: { type: 'string' },
    target: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
  },
  required: ['key', 'action'],
  additionalProperties: false,
};

const widgetInteractionHandlerListSchema: Record<string, unknown> = {
  oneOf: [
    widgetInteractionHandlerSchema,
    { type: 'array', items: widgetInteractionHandlerSchema },
  ],
};

export const widgetInteractionSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    hover: widgetInteractionHandlerListSchema,
    click: widgetInteractionHandlerListSchema,
    focus: widgetInteractionHandlerListSchema,
    blur: widgetInteractionHandlerListSchema,
    key: { type: 'array', items: widgetKeyInteractionSchema },
  },
  additionalProperties: false,
};

function cloneStateStyle(value: unknown): WidgetStyleStateSpec | undefined {
  if (!isObject(value)) return undefined;
  return cleanObject({
    ...(typeof value.className === 'string' ? { className: value.className } : {}),
    ...(typeof value.variant === 'string' ? { variant: value.variant } : {}),
    ...(isObject(value.tokens) ? { tokens: value.tokens } : {}),
  });
}

export function decodeWidgetStyleSpec(value: unknown): WidgetStyleSpec | undefined {
  if (!isObject(value)) return undefined;
  const states = isObject(value.states)
    ? cleanObject({
        ...(cloneStateStyle(value.states.default) ? { default: cloneStateStyle(value.states.default) } : {}),
        ...(cloneStateStyle(value.states.hovered) ? { hovered: cloneStateStyle(value.states.hovered) } : {}),
        ...(cloneStateStyle(value.states.focused) ? { focused: cloneStateStyle(value.states.focused) } : {}),
        ...(cloneStateStyle(value.states.pressed) ? { pressed: cloneStateStyle(value.states.pressed) } : {}),
        ...(cloneStateStyle(value.states.disabled) ? { disabled: cloneStateStyle(value.states.disabled) } : {}),
        ...(cloneStateStyle(value.states.selected) ? { selected: cloneStateStyle(value.states.selected) } : {}),
      })
    : undefined;
  return cleanObject({
    ...(isObject(value.decoration) ? { decoration: BoxDecoration.fromJSON(value.decoration as never) } : {}),
    ...(typeof value.className === 'string' ? { className: value.className } : {}),
    ...(typeof value.variant === 'string' ? { variant: value.variant } : {}),
    ...(isObject(value.tokens) ? { tokens: value.tokens } : {}),
    ...(states ? { states } : {}),
  });
}

export function encodeWidgetStyleSpec(style: WidgetStyleSpec | undefined): Record<string, unknown> | undefined {
  if (!style) return undefined;
  const states = style.states
    ? cleanObject({
        ...(style.states.default ? { default: style.states.default } : {}),
        ...(style.states.hovered ? { hovered: style.states.hovered } : {}),
        ...(style.states.focused ? { focused: style.states.focused } : {}),
        ...(style.states.pressed ? { pressed: style.states.pressed } : {}),
        ...(style.states.disabled ? { disabled: style.states.disabled } : {}),
        ...(style.states.selected ? { selected: style.states.selected } : {}),
      })
    : undefined;
  return cleanObject({
    ...(style.decoration ? { decoration: style.decoration.toJSON() as unknown as Record<string, unknown> } : {}),
    ...(style.className ? { className: style.className } : {}),
    ...(style.variant ? { variant: style.variant } : {}),
    ...(style.tokens ? { tokens: style.tokens } : {}),
    ...(states ? { states } : {}),
  });
}

export function decodeWidgetChromeSpec(value: unknown): WidgetChromeSpec | undefined {
  if (!isObject(value)) return undefined;
  return cleanObject({
    ...(typeof value.variant === 'string' ? { variant: value.variant as WidgetChromeVariant } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.titleAlign === 'string' ? { titleAlign: value.titleAlign as WidgetChromeAlign } : {}),
    ...(typeof value.titleSuffix === 'string' ? { titleSuffix: value.titleSuffix } : {}),
    ...(typeof value.footer === 'string' ? { footer: value.footer } : {}),
    ...(typeof value.showBorder === 'boolean' ? { showBorder: value.showBorder } : {}),
    ...(typeof value.showClose === 'boolean' ? { showClose: value.showClose } : {}),
  });
}

export function decodeWidgetMotionSpec(value: unknown): WidgetMotionSpec | undefined {
  if (!isObject(value)) return undefined;
  const phase = (input: unknown): WidgetMotionPhaseSpec | undefined => {
    if (!isObject(input)) return undefined;
    return cleanObject({
      ...(typeof input.preset === 'string' ? { preset: input.preset as WidgetMotionPreset } : {}),
      ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
      ...(typeof input.delayMs === 'number' ? { delayMs: input.delayMs } : {}),
      ...(typeof input.easing === 'string' ? { easing: input.easing as WidgetMotionEasing } : {}),
    });
  };
  return cleanObject({
    ...(phase(value) ?? {}),
    ...(phase(value.enter) ? { enter: phase(value.enter) } : {}),
    ...(phase(value.exit) ? { exit: phase(value.exit) } : {}),
    ...(phase(value.hover) ? { hover: phase(value.hover) } : {}),
    ...(phase(value.focus) ? { focus: phase(value.focus) } : {}),
  });
}

function decodeInteractionHandler(
  value: unknown,
): WidgetInteractionHandlerSpec | undefined {
  if (!isObject(value) || typeof value.action !== 'string') return undefined;
  return cleanObject({
    action: value.action,
    ...(typeof value.target === 'string' ? { target: value.target } : {}),
    ...(isObject(value.payload) ? { payload: value.payload } : {}),
  });
}

function decodeInteractionHandlers(
  value: unknown,
): WidgetInteractionHandlerSpec | readonly WidgetInteractionHandlerSpec[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map(decodeInteractionHandler)
      .filter((item): item is WidgetInteractionHandlerSpec => !!item);
    return items.length > 0 ? items : undefined;
  }
  return decodeInteractionHandler(value);
}

export function decodeWidgetInteractionSpec(value: unknown): WidgetInteractionSpec | undefined {
  if (!isObject(value)) return undefined;
  const key = Array.isArray(value.key)
    ? value.key
        .map((entry): WidgetKeyInteractionSpec | null => {
          if (!isObject(entry) || typeof entry.key !== 'string' || typeof entry.action !== 'string') return null;
          return cleanObject({
            key: entry.key,
            action: entry.action,
            ...(typeof entry.target === 'string' ? { target: entry.target } : {}),
            ...(isObject(entry.payload) ? { payload: entry.payload } : {}),
          }) as WidgetKeyInteractionSpec;
        })
        .filter((entry): entry is WidgetKeyInteractionSpec => !!entry)
    : [];
  return cleanObject({
    ...(decodeInteractionHandlers(value.hover) ? { hover: decodeInteractionHandlers(value.hover) } : {}),
    ...(decodeInteractionHandlers(value.click) ? { click: decodeInteractionHandlers(value.click) } : {}),
    ...(decodeInteractionHandlers(value.focus) ? { focus: decodeInteractionHandlers(value.focus) } : {}),
    ...(decodeInteractionHandlers(value.blur) ? { blur: decodeInteractionHandlers(value.blur) } : {}),
    ...(key.length > 0 ? { key } : {}),
  });
}
