import type { BoxDecoration } from '../attributes/index.js';
import { encodeWidgetSpecsYAML } from './encode-specs.js';
import type {
  WidgetChromeSpec,
  WidgetInteractionHandlerSpec,
  WidgetInteractionSpec,
  WidgetKeyInteractionSpec,
  WidgetMotionPhaseSpec,
  WidgetMotionSpec,
  WidgetSpec,
  WidgetStyleStateName,
  WidgetStyleStateSpec,
  WidgetStyleSpec,
} from './spec.js';

function normalizeHandler(
  handler: string | WidgetInteractionHandlerSpec,
  payload?: Record<string, unknown>,
): WidgetInteractionHandlerSpec {
  if (typeof handler === 'string') {
    return {
      action: handler,
      ...(payload ? { payload } : {}),
    };
  }
  return handler;
}

function appendInteraction(
  current: WidgetInteractionSpec['hover'],
  next: WidgetInteractionHandlerSpec,
): WidgetInteractionSpec['hover'] {
  if (!current) return next;
  if (Array.isArray(current)) return [...current, next];
  const single = current as WidgetInteractionHandlerSpec;
  return [single, next];
}

export class WidgetBuilder {
  private spec: WidgetSpec;

  constructor(type: string) {
    this.spec = { type };
  }

  withId(id: string): this {
    this.spec = { ...this.spec, id };
    return this;
  }

  withCharacter(character: string): this {
    this.spec = { ...this.spec, character };
    return this;
  }

  withConfig(config: Record<string, unknown>): this {
    this.spec = { ...this.spec, config };
    return this;
  }

  patchConfig(patch: Record<string, unknown>): this {
    this.spec = {
      ...this.spec,
      config: { ...(this.spec.config ?? {}), ...patch },
    };
    return this;
  }

  setStyle(style: Partial<WidgetStyleSpec>): this {
    this.spec = {
      ...this.spec,
      style: { ...(this.spec.style ?? {}), ...style },
      ...(style.decoration ? { decoration: style.decoration } : {}),
    };
    return this;
  }

  setDecoration(decoration: BoxDecoration): this {
    return this.setStyle({ decoration });
  }

  setVariant(variant: string): this {
    return this.setStyle({ variant });
  }

  setClassName(className: string): this {
    return this.setStyle({ className });
  }

  setToken(name: string, value: unknown): this {
    return this.setStyle({
      tokens: {
        ...(this.spec.style?.tokens ?? {}),
        [name]: value,
      },
    });
  }

  setStateStyle(state: WidgetStyleStateName, patch: WidgetStyleStateSpec): this {
    return this.setStyle({
      states: {
        ...(this.spec.style?.states ?? {}),
        [state]: {
          ...(this.spec.style?.states?.[state] ?? {}),
          ...patch,
        },
      },
    });
  }

  setChrome(chrome: Partial<WidgetChromeSpec>): this {
    this.spec = {
      ...this.spec,
      chrome: { ...(this.spec.chrome ?? {}), ...chrome },
    };
    return this;
  }

  setChromeTitle(title: string): this {
    return this.setChrome({ title });
  }

  setChromeTitleAlign(titleAlign: NonNullable<WidgetChromeSpec['titleAlign']>): this {
    return this.setChrome({ titleAlign });
  }

  setFooter(footer: string): this {
    return this.setChrome({ footer });
  }

  setChromeVariant(variant: NonNullable<WidgetChromeSpec['variant']>): this {
    return this.setChrome({ variant });
  }

  withChromeRole(
    variant: NonNullable<WidgetChromeSpec['variant']>,
    title?: string,
  ): this {
    this.setChromeVariant(variant);
    this.showBorder(true);
    if (title) this.setChromeTitle(title);
    return this;
  }

  showCloseButton(showClose = true): this {
    return this.setChrome({ showClose });
  }

  showBorder(showBorder = true): this {
    return this.setChrome({ showBorder });
  }

  setMotion(motion: Partial<WidgetMotionSpec>): this {
    this.spec = {
      ...this.spec,
      motion: { ...(this.spec.motion ?? {}), ...motion },
    };
    return this;
  }

  private setMotionPhase(
    phase: 'enter' | 'exit' | 'hover' | 'focus',
    motion: WidgetMotionPhaseSpec,
  ): this {
    return this.setMotion({
      [phase]: {
        ...(this.spec.motion?.[phase] ?? {}),
        ...motion,
      },
    });
  }

  animateEnter(motion: WidgetMotionPhaseSpec): this {
    return this.setMotionPhase('enter', motion);
  }

  animateExit(motion: WidgetMotionPhaseSpec): this {
    return this.setMotionPhase('exit', motion);
  }

  animateHover(motion: WidgetMotionPhaseSpec): this {
    return this.setMotionPhase('hover', motion);
  }

  animateFocus(motion: WidgetMotionPhaseSpec): this {
    return this.setMotionPhase('focus', motion);
  }

  private patchInteractions(patch: Partial<WidgetInteractionSpec>): this {
    this.spec = {
      ...this.spec,
      interactions: { ...(this.spec.interactions ?? {}), ...patch },
    };
    return this;
  }

  onHover(handler: string | WidgetInteractionHandlerSpec, payload?: Record<string, unknown>): this {
    const next = normalizeHandler(handler, payload);
    return this.patchInteractions({
      hover: appendInteraction(this.spec.interactions?.hover, next),
    });
  }

  onClick(handler: string | WidgetInteractionHandlerSpec, payload?: Record<string, unknown>): this {
    const next = normalizeHandler(handler, payload);
    return this.patchInteractions({
      click: appendInteraction(this.spec.interactions?.click, next),
    });
  }

  onFocus(handler: string | WidgetInteractionHandlerSpec, payload?: Record<string, unknown>): this {
    const next = normalizeHandler(handler, payload);
    return this.patchInteractions({
      focus: appendInteraction(this.spec.interactions?.focus, next),
    });
  }

  onBlur(handler: string | WidgetInteractionHandlerSpec, payload?: Record<string, unknown>): this {
    const next = normalizeHandler(handler, payload);
    return this.patchInteractions({
      blur: appendInteraction(this.spec.interactions?.blur, next),
    });
  }

  onKey(
    key: string,
    handler: string | WidgetInteractionHandlerSpec,
    payload?: Record<string, unknown>,
  ): this {
    const next = normalizeHandler(handler, payload);
    const binding: WidgetKeyInteractionSpec = { key, ...next };
    return this.patchInteractions({
      key: [...(this.spec.interactions?.key ?? []), binding],
    });
  }

  withChild(child: WidgetBuilder | WidgetSpec): this {
    const built = child instanceof WidgetBuilder ? child.build() : child;
    this.spec = {
      ...this.spec,
      children: [...(this.spec.children ?? []), built],
    };
    return this;
  }

  build(): WidgetSpec {
    return {
      ...this.spec,
      ...(this.spec.style?.decoration ? { decoration: this.spec.style.decoration } : {}),
    };
  }

  async buildYAML(): Promise<string> {
    return encodeWidgetSpecsYAML([this.build()]);
  }
}

export type DeclarativeWidgetNode = WidgetSpec | WidgetBuilder;

export function buildWidgetSpec(
  node: DeclarativeWidgetNode,
): WidgetSpec {
  return node instanceof WidgetBuilder ? node.build() : node;
}

export function buildWidgetSpecs(
  nodes: readonly DeclarativeWidgetNode[],
): readonly WidgetSpec[] {
  return nodes.map((node) => buildWidgetSpec(node));
}

export function widget(type: string): WidgetBuilder {
  return new WidgetBuilder(type);
}

export interface DeclarativeDialogButtonSpec {
  label: string;
  value?: unknown;
  shortcut?: string;
  style?: string;
}

export interface DeclarativeIntakeActionSpec {
  label: string;
  value?: unknown;
}

export interface DeclarativeSelectOptionSpec {
  label: string;
  value?: unknown;
  shortcut?: string;
  description?: string;
  disabled?: boolean;
  positive?: boolean;
}

export interface DeclarativeToastItemSpec {
  text: string;
  kind?: string;
}

export interface DeclarativeCommandSpec {
  name: string;
  description: string;
  category?: string;
}

function buildSelectOption(
  option: DeclarativeSelectOptionSpec | DeclarativeSelectOptionBuilder,
): DeclarativeSelectOptionSpec {
  const built = option instanceof DeclarativeSelectOptionBuilder ? option.build() : option;
  return { ...built };
}

function buildQuestion(
  question: DeclarativeQuestionSpec | DeclarativeQuestionBuilder,
): DeclarativeQuestionSpec {
  const built = question instanceof DeclarativeQuestionBuilder ? question.build() : question;
  return {
    ...built,
    ...(built.options ? { options: built.options.map((option) => ({ ...option })) } : {}),
    ...(built.inputType ? { inputType: { ...built.inputType } } : {}),
  };
}

function buildCommand(
  command: DeclarativeCommandSpec | DeclarativeCommandBuilder,
): DeclarativeCommandSpec {
  const built = command instanceof DeclarativeCommandBuilder ? command.build() : command;
  return { ...built };
}

function buildDialogButton(
  button: string | DeclarativeDialogButtonSpec | DeclarativeDialogButtonBuilder,
): DeclarativeDialogButtonSpec {
  if (typeof button === 'string') return { label: button, value: button };
  const built = button instanceof DeclarativeDialogButtonBuilder ? button.build() : button;
  return built.value === undefined ? { ...built, value: built.label } : { ...built };
}

function buildIntakeAction(
  action: string | DeclarativeIntakeActionSpec | DeclarativeIntakeActionBuilder,
): DeclarativeIntakeActionSpec {
  if (typeof action === 'string') return { label: action, value: action };
  const built = action instanceof DeclarativeIntakeActionBuilder ? action.build() : action;
  return built.value === undefined ? { ...built, value: built.label } : { ...built };
}

export class DialogWidgetBuilder extends WidgetBuilder {
  setBody(body: string): this {
    return this.patchConfig({ body });
  }

  setButtons(buttons: readonly (string | DeclarativeDialogButtonSpec | DeclarativeDialogButtonBuilder)[]): this {
    return this.patchConfig({
      buttons: buttons.map((button) => buildDialogButton(button)),
    });
  }
}

export class TooltipWidgetBuilder extends WidgetBuilder {
  setText(text: string): this {
    return this.patchConfig({ text });
  }

  setTtl(ttlMs: number): this {
    return this.patchConfig({ ttlMs });
  }
}

export class ListWidgetBuilder extends WidgetBuilder {
  setItems(items: readonly string[]): this {
    return this.patchConfig({ items: [...items] });
  }

  setIcons(icons: readonly string[]): this {
    return this.patchConfig({ icons: [...icons] });
  }
}

export class LogWidgetBuilder extends WidgetBuilder {
  setLines(lines: readonly string[]): this {
    return this.patchConfig({ lines: [...lines] });
  }
}

export class ToastStackWidgetBuilder extends WidgetBuilder {
  setPlacement(placement: string): this {
    return this.patchConfig({ placement });
  }

  setItems(items: readonly DeclarativeToastItemSpec[]): this {
    return this.patchConfig({ items: items.map((item) => ({ ...item })) });
  }
}

export class TextAreaWidgetBuilder extends WidgetBuilder {
  setText(text: string): this {
    return this.patchConfig({ text });
  }

  setReadOnly(readOnly = true): this {
    return this.patchConfig({ readOnly });
  }

  setWrap(wrap = true): this {
    return this.patchConfig({ wrap });
  }

  setMaxLength(maxLength: number): this {
    return this.patchConfig({ maxLength });
  }
}

export class DeclarativeSelectOptionBuilder {
  private spec: DeclarativeSelectOptionSpec;

  constructor(label: string, value?: unknown) {
    this.spec = value === undefined ? { label } : { label, value };
  }

  setValue(value: unknown): this {
    this.spec = { ...this.spec, value };
    return this;
  }

  setShortcut(shortcut: string): this {
    this.spec = { ...this.spec, shortcut };
    return this;
  }

  setDescription(description: string): this {
    this.spec = { ...this.spec, description };
    return this;
  }

  setDisabled(disabled = true): this {
    this.spec = { ...this.spec, disabled };
    return this;
  }

  setPositive(positive = true): this {
    this.spec = { ...this.spec, positive };
    return this;
  }

  build(): DeclarativeSelectOptionSpec {
    return { ...this.spec };
  }
}

export class DeclarativeCommandBuilder {
  private spec: DeclarativeCommandSpec;

  constructor(name: string, description: string) {
    this.spec = { name, description };
  }

  setDescription(description: string): this {
    this.spec = { ...this.spec, description };
    return this;
  }

  setCategory(category: string): this {
    this.spec = { ...this.spec, category };
    return this;
  }

  build(): DeclarativeCommandSpec {
    return { ...this.spec };
  }
}

export class DeclarativeDialogButtonBuilder {
  private spec: DeclarativeDialogButtonSpec;

  constructor(label: string, value?: unknown) {
    this.spec = value === undefined ? { label } : { label, value };
  }

  setValue(value: unknown): this {
    this.spec = { ...this.spec, value };
    return this;
  }

  setShortcut(shortcut: string): this {
    this.spec = { ...this.spec, shortcut };
    return this;
  }

  setStyle(style: string): this {
    this.spec = { ...this.spec, style };
    return this;
  }

  build(): DeclarativeDialogButtonSpec {
    return { ...this.spec };
  }
}

export class PermissionPromptWidgetBuilder extends WidgetBuilder {
  constructor(title?: string) {
    super('permission-prompt');
    this.withChromeRole('dialog', title);
    if (title) this.patchConfig({ title });
  }

  setTitle(title: string): this {
    return this.patchConfig({ title });
  }

  setBody(body: string): this {
    return this.patchConfig({ body });
  }

  setChoices(choices: readonly (DeclarativeSelectOptionSpec | DeclarativeSelectOptionBuilder)[]): this {
    return this.patchConfig({ choices: choices.map((choice) => buildSelectOption(choice)) });
  }

  setFeedbackPrompt(placeholder: string, maxLength?: number): this {
    return this.patchConfig({
      feedbackPlaceholder: placeholder,
      ...(maxLength !== undefined ? { feedbackMaxLength: maxLength } : {}),
    });
  }
}

export class CommandMenuWidgetBuilder extends WidgetBuilder {
  constructor(title?: string) {
    super('slash-menu');
    this.withChromeRole('panel', title);
    if (title) this.patchConfig({ title });
  }

  setTitle(title: string): this {
    return this.patchConfig({ title });
  }

  setCommands(commands: readonly (DeclarativeCommandSpec | DeclarativeCommandBuilder)[]): this {
    return this.patchConfig({ commands: commands.map((command) => buildCommand(command)) });
  }
}

export class ContextMenuWidgetBuilder extends WidgetBuilder {
  constructor(title?: string) {
    super('context-menu');
    this.withChromeRole('panel', title);
    if (title) this.patchConfig({ title });
  }

  setTitle(title: string): this {
    return this.patchConfig({ title });
  }

  setItems(items: readonly (DeclarativeSelectOptionSpec | DeclarativeSelectOptionBuilder)[]): this {
    return this.patchConfig({ items: items.map((item) => buildSelectOption(item)) });
  }
}

export class FileDialogWidgetBuilder extends WidgetBuilder {
  setStartDir(startDir: string): this {
    return this.patchConfig({ startDir });
  }

  setMode(mode: 'open' | 'save' | 'dir'): this {
    return this.patchConfig({ mode });
  }

  showHidden(showHidden = true): this {
    return this.patchConfig({ showHidden });
  }

  setDefaultName(defaultName: string): this {
    return this.patchConfig({ defaultName });
  }

  setBrowseMode(browseMode = true): this {
    return this.patchConfig({ browseMode });
  }
}

export interface DeclarativeQuestionSpec {
  id: string;
  title: string;
  options?: readonly DeclarativeSelectOptionSpec[];
  inputType?: { placeholder?: string; initialValue?: string };
  allowNotes?: boolean;
  notesPlaceholder?: string;
}

export class DeclarativeQuestionBuilder {
  private spec: DeclarativeQuestionSpec;

  constructor(id: string, title: string) {
    this.spec = { id, title };
  }

  setOptions(options: readonly (DeclarativeSelectOptionSpec | DeclarativeSelectOptionBuilder)[]): this {
    this.spec = {
      ...this.spec,
      options: options.map((option) => buildSelectOption(option)),
    };
    return this;
  }

  setInputType(inputType: { placeholder?: string; initialValue?: string }): this {
    this.spec = {
      ...this.spec,
      inputType: { ...inputType },
    };
    return this;
  }

  allowNotes(notesPlaceholder?: string): this {
    this.spec = {
      ...this.spec,
      allowNotes: true,
      ...(notesPlaceholder !== undefined ? { notesPlaceholder } : {}),
    };
    return this;
  }

  build(): DeclarativeQuestionSpec {
    return {
      ...this.spec,
      ...(this.spec.options ? { options: this.spec.options.map((option) => ({ ...option })) } : {}),
      ...(this.spec.inputType ? { inputType: { ...this.spec.inputType } } : {}),
    };
  }
}

export class RequestUserInputWidgetBuilder extends WidgetBuilder {
  allowBackNav(allowBackNav = true): this {
    return this.patchConfig({ allowBackNav });
  }

  setQuestions(questions: readonly (DeclarativeQuestionSpec | DeclarativeQuestionBuilder)[]): this {
    return this.patchConfig({
      questions: questions.map((question) => buildQuestion(question)),
    });
  }
}

export class IntakeReviewWidgetBuilder extends WidgetBuilder {
  constructor(title?: string) {
    super('intake-review');
    this.withChromeRole('dialog', title);
    if (title) this.patchConfig({ title });
  }

  setTitle(title: string): this {
    return this.patchConfig({ title });
  }

  setBody(body: string): this {
    return this.patchConfig({ body });
  }

  setQuestions(questions: readonly (DeclarativeQuestionSpec | DeclarativeQuestionBuilder)[]): this {
    return this.patchConfig({
      questions: questions.map((question) => buildQuestion(question)),
    });
  }

  setActions(actions: readonly (string | DeclarativeIntakeActionSpec | DeclarativeIntakeActionBuilder)[]): this {
    return this.patchConfig({
      actions: actions.map((action) => buildIntakeAction(action)),
    });
  }
}

export class DeclarativeIntakeActionBuilder {
  private spec: DeclarativeIntakeActionSpec;

  constructor(label: string, value?: unknown) {
    this.spec = value === undefined ? { label } : { label, value };
  }

  setValue(value: unknown): this {
    this.spec = { ...this.spec, value };
    return this;
  }

  build(): DeclarativeIntakeActionSpec {
    return { ...this.spec };
  }
}

export function windowWidget(type: string, title?: string): WidgetBuilder {
  return widget(type).withChromeRole('window', title);
}

export function logWidget(title?: string): LogWidgetBuilder {
  return new LogWidgetBuilder('log').withChromeRole('window', title);
}

export function dialogWidget(type: string, title?: string): DialogWidgetBuilder {
  return new DialogWidgetBuilder(type).withChromeRole('dialog', title);
}

export function panelWidget(type: string, title?: string): WidgetBuilder {
  return widget(type).withChromeRole('panel', title);
}

export function toastStackWidget(title?: string): ToastStackWidgetBuilder {
  return new ToastStackWidgetBuilder('toast-stack').withChromeRole('panel', title);
}

export function textAreaWidget(title?: string): TextAreaWidgetBuilder {
  return new TextAreaWidgetBuilder('text-area').withChromeRole('panel', title);
}

export function tooltipWidget(type: string, title?: string): TooltipWidgetBuilder {
  return new TooltipWidgetBuilder(type).withChromeRole('tooltip', title);
}

export function listWidget(title?: string): ListWidgetBuilder {
  return new ListWidgetBuilder('list').withChromeRole('panel', title);
}

export function permissionPromptWidget(title?: string): PermissionPromptWidgetBuilder {
  return new PermissionPromptWidgetBuilder(title);
}

export function slashMenuWidget(title?: string): CommandMenuWidgetBuilder {
  return new CommandMenuWidgetBuilder(title);
}

export function contextMenuWidget(title?: string): ContextMenuWidgetBuilder {
  return new ContextMenuWidgetBuilder(title);
}

export function fileDialogWidget(title?: string): FileDialogWidgetBuilder {
  return new FileDialogWidgetBuilder('file-dialog').withChromeRole('window', title);
}

export function requestUserInputWidget(title?: string): RequestUserInputWidgetBuilder {
  return new RequestUserInputWidgetBuilder('request-user-input-overlay').withChromeRole('dialog', title);
}

export function option(label: string, value?: unknown): DeclarativeSelectOptionBuilder {
  return new DeclarativeSelectOptionBuilder(label, value);
}

export function question(id: string, title: string): DeclarativeQuestionBuilder {
  return new DeclarativeQuestionBuilder(id, title);
}

export function command(name: string, description: string): DeclarativeCommandBuilder {
  return new DeclarativeCommandBuilder(name, description);
}

export function dialogButton(label: string, value?: unknown): DeclarativeDialogButtonBuilder {
  return new DeclarativeDialogButtonBuilder(label, value);
}

export function intakeAction(label: string, value?: unknown): DeclarativeIntakeActionBuilder {
  return new DeclarativeIntakeActionBuilder(label, value);
}

export function intakeReviewWidget(title?: string): IntakeReviewWidgetBuilder {
  return new IntakeReviewWidgetBuilder(title);
}
