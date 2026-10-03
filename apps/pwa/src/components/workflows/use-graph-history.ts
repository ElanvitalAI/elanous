import { useCallback, useReducer, useRef } from 'react';
import { GraphHistory } from './graph-history';

/** React state bridge for the YAML-only history. The caller owns the current YAML. */
export function useGraphHistory() {
  const history = useRef<GraphHistory>(new GraphHistory());
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  const record = useCallback((yaml: string) => {
    history.current.record(yaml);
    refresh();
  }, []);

  const undo = useCallback((currentYaml: string): string | null => {
    const previous = history.current.undo(currentYaml);
    if (previous !== null) refresh();
    return previous;
  }, []);

  const redo = useCallback((currentYaml: string): string | null => {
    const next = history.current.redo(currentYaml);
    if (next !== null) refresh();
    return next;
  }, []);

  const reset = useCallback(() => {
    history.current = new GraphHistory();
    refresh();
  }, []);

  return { record, undo, redo, reset, canUndo: history.current.canUndo, canRedo: history.current.canRedo };
}
