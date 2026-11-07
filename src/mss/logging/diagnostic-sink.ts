/** Minimal bridge from low-level MSS modules to the runtime debug logger. */
export interface DiagnosticSink {
  log(category: string, event: string, data?: unknown, options?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' }): void;
  flush(): void;
}

type DiagnosticOperation =
  | { kind: 'log'; category: string; event: string; data?: unknown; options?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' } }
  | { kind: 'flush' };

export function createDiagnosticBridge(bootstrapLogger?: () => void, bootstrapOnLog = false) {
  let sink: DiagnosticSink | undefined;
  let draining = false;
  let bootstrapping = false;
  const pending: DiagnosticOperation[] = [];

  const ensureLogger = (): void => {
    if (sink || !bootstrapLogger || bootstrapping) return;
    bootstrapping = true;
    try { bootstrapLogger(); } catch { /* diagnostics remain queued if bootstrap is unavailable */ }
    finally { bootstrapping = false; }
  };

  const dispatch = (operation: DiagnosticOperation, target: DiagnosticSink): void => {
    if (operation.kind === 'flush') target.flush();
    else target.log(operation.category, operation.event, operation.data, operation.options);
  };

  const submit = (operation: DiagnosticOperation): void => {
    if (!sink || draining) {
      pending.push(operation);
      return;
    }
    dispatch(operation, sink);
  };

  return {
    /** Queue diagnostics until the runtime logger is ready, then replay in order. */
    registerDiagnosticSink(next: DiagnosticSink): () => void {
      const previous = sink;
      sink = next;
      draining = true;
      try {
        while (pending.length > 0) dispatch(pending.shift()!, next);
      } finally {
        draining = false;
      }
      return () => {
        if (sink === next) sink = previous;
      };
    },
    logDiagnostic(
      category: string,
      event: string,
      data?: unknown,
      options?: { level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical' },
    ): void {
      submit({ kind: 'log', category, event, data, options });
      if (bootstrapOnLog) ensureLogger();
    },
    flushDiagnostics(): void {
      ensureLogger();
      submit({ kind: 'flush' });
    },
  };
}

const runtimeBridge = createDiagnosticBridge(() => {
  // Fatal handlers may flush before normal application bootstrap has imported the logger.
  // Keep this synchronous and lazy so the low-level module has no static logger edge.
  const loggerModulePath: string = '../../debug/log.js';
  require(loggerModulePath);
}, true);
export const registerDiagnosticSink = runtimeBridge.registerDiagnosticSink;
export const logDiagnostic = runtimeBridge.logDiagnostic;
export const flushDiagnostics = runtimeBridge.flushDiagnostics;

// The foundation logger and this low-layer bridge must not import each other:
// either side may load first. A process-local hook keeps that edge out of both
// static graphs while still registering immediately when the second side starts.
const hooks = globalThis as unknown as Record<string, unknown>;
const LOGGER_HOOK = '__elanous_mss_diagnostic_logger__';
const REGISTER_HOOK = '__elanous_mss_diagnostic_register__';
hooks[REGISTER_HOOK] = registerDiagnosticSink;
const existingLogger = hooks[LOGGER_HOOK];
if (existingLogger && typeof existingLogger === 'object'
  && 'log' in existingLogger && typeof existingLogger.log === 'function'
  && 'flush' in existingLogger && typeof existingLogger.flush === 'function') {
  registerDiagnosticSink(existingLogger as DiagnosticSink);
}
