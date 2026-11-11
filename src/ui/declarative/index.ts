// ── Presentation P3 · Declarative pipeline · public barrel ──
//
// WidgetSchemaRegistry + decode / encode + validator · drives the
// declarative pipeline that lets the LLM or user author widget trees
// as JSON/YAML.

export {
  registerWidgetSchema,
  harvestWidgetSchema,
  getWidgetSchema,
  hasWidgetSchema,
  listWidgetSchemas,
  _resetWidgetSchemaRegistryForTest,
  type WidgetSchemaEntry,
  type HarvestableWidgetDef,
} from './schema.js';

export {
  ensureBuiltinDeclarativeViewSchemasRegistered,
} from './builtin-view-schemas.js';

export {
  decodeWidgetTree,
  decodeWidgetTreeYAML,
  type DecodeOptions,
  type DecodeResult,
} from './decode.js';

export {
  type WidgetSpec,
  type WidgetStyleSpec,
  type WidgetChromeSpec,
  type WidgetMotionSpec,
  type WidgetInteractionSpec,
  type WidgetInteractionHandlerSpec,
  type WidgetKeyInteractionSpec,
  widgetStyleSchema,
  widgetChromeSchema,
  widgetMotionSchema,
  widgetInteractionSchema,
} from './spec.js';

export {
  encodeWidgetTree,
  encodeWidgetTreeYAML,
  type EncodedNode,
  type EncodedTree,
} from './encode.js';

export {
  validateJSON,
  type ValidationError,
  type ValidationResult,
} from './validate.js';

export {
  WidgetBuilder,
  buildWidgetSpec,
  buildWidgetSpecs,
  DialogWidgetBuilder,
  ListWidgetBuilder,
  LogWidgetBuilder,
  ToastStackWidgetBuilder,
  TextAreaWidgetBuilder,
  PermissionPromptWidgetBuilder,
  CommandMenuWidgetBuilder,
  ContextMenuWidgetBuilder,
  FileDialogWidgetBuilder,
  RequestUserInputWidgetBuilder,
  IntakeReviewWidgetBuilder,
  DeclarativeSelectOptionBuilder,
  DeclarativeDialogButtonBuilder,
  DeclarativeQuestionBuilder,
  DeclarativeCommandBuilder,
  DeclarativeIntakeActionBuilder,
  type DeclarativeWidgetNode,
  widget,
  windowWidget,
  logWidget,
  dialogWidget,
  panelWidget,
  toastStackWidget,
  textAreaWidget,
  listWidget,
  permissionPromptWidget,
  slashMenuWidget,
  contextMenuWidget,
  fileDialogWidget,
  requestUserInputWidget,
  intakeReviewWidget,
  option,
  dialogButton,
  question,
  command,
  intakeAction,
  type DeclarativeDialogButtonSpec,
  type DeclarativeSelectOptionSpec,
  type DeclarativeCommandSpec,
  type DeclarativeToastItemSpec,
  type DeclarativeQuestionSpec,
  type DeclarativeIntakeActionSpec,
} from './builder.js';

export {
  materializeWidgetSpecs,
  widgetSpawnInputFromSpec,
  type DeclarativeWidgetHostLike,
  type MaterializedWidgetRecord,
} from './materialize.js';

export {
  registerDeclarativeViewFactory,
  registerDeclarativeViewDefinition,
  hasDeclarativeViewFactory,
  canCreateDeclarativeView,
  createDeclarativeView,
  type DeclarativeViewDefinition,
  type DeclarativeViewRuntimeDeps,
} from './view-runtime.js';

export {
  resolveDeclarativeRuntimeSupport,
  createDeclarativeRuntimeArtifact,
  type DeclarativeRuntimeKind,
  type DeclarativeRuntimeSupport,
  type DeclarativeRuntimeArtifact,
  type DeclarativeRuntimeOptions,
  type DeclarativeWidgetTypeResolver,
} from './runtime.js';

export {
  listWidgetLabPresets,
  getWidgetLabPreset,
  buildWidgetLabPresetNodes,
  buildWidgetLabPreset,
  buildWidgetLabPresetYAML,
  buildWidgetLabPresetReferenceYAML,
  cycleWidgetLabPreset,
  type WidgetLabPreset,
} from './presets.js';

export {
  resolveWidgetSpecTitle,
  resolveWidgetSpecDecoration,
  resolveWidgetChromeBoxViewOptions,
  summarizeWidgetMotion,
  renderWidgetSpecPreviewCard,
} from './presentation.js';
