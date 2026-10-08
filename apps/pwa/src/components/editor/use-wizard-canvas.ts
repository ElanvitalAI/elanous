'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyGraph, type CanvasGraph } from './graph-canvas-model';
import type { GraphCanvasContext } from './GraphCanvasEditor';
import type { CanvasSnapshot } from './GraphWizardChat';
import type { WizardDiff } from './graph-wizard';
import type { GraphWizardSteps } from '@/nexus/client';

/** GRAPH-WIZARD — the wiring between the «말로 만들기» chat and `GraphCanvasEditor`, in one place so the
 *  editor and its test use the same path: the canvas reports itself through `onChange`, the chat reads it
 *  with `current`, and a turn (or its undo) goes back to the canvas as `replace` + a short `highlight`. */
export function useWizardCanvas(highlightMs = 2600) {
  const [replace, setReplace] = useState<{ rev: number; graph: CanvasGraph; autoLayout?: boolean } | undefined>(undefined);
  const [highlight, setHighlight] = useState<WizardDiff | undefined>(undefined);
  /** v2 Korean node names, accumulated over turns (a name outlives an undo — it only labels ids that exist). */
  const [labels, setLabels] = useState<Record<string, string>>({});
  /** The wizard's latest node → step map (whole map per turn — it describes the graph that turn returned). */
  const [steps, setSteps] = useState<GraphWizardSteps | undefined>(undefined);
  const now = useRef<GraphCanvasContext | null>(null);
  const rev = useRef(0);
  /** The graph as the canvas holds it right after a wizard turn or undo — «has the user moved nodes since?». */
  const laidRef = useRef<CanvasGraph | null>(null);
  const awaitingLaid = useRef(false);

  const onChange = useCallback((context: GraphCanvasContext) => {
    now.current = context;
    if (awaitingLaid.current) { laidRef.current = context.graph; awaitingLaid.current = false; }
  }, []);
  const laid = useCallback(() => laidRef.current, []);
  const current = useCallback((): CanvasSnapshot | null => now.current ? { graph: now.current.graph, yaml: now.current.yaml } : null, []);
  const apply = useCallback((graph: CanvasGraph, added: WizardDiff, autoLayout = false, names?: Record<string, string>, nodeSteps?: GraphWizardSteps) => {
    // The steps describe the graph this turn returned — a reply without them leaves none (never the previous turn's).
    setSteps(nodeSteps && Object.keys(nodeSteps).length ? nodeSteps : undefined);
    if (names && Object.keys(names).length) setLabels((all) => ({ ...all, ...names }));
    rev.current += 1;
    awaitingLaid.current = true;
    setReplace({ rev: rev.current, graph, ...(autoLayout ? { autoLayout } : {}) });
    setHighlight(added);
  }, []);
  const restore = useCallback((graph: CanvasGraph | null, nodeSteps?: GraphWizardSteps) => {
    setSteps(nodeSteps && Object.keys(nodeSteps).length ? nodeSteps : undefined);
    rev.current += 1;
    awaitingLaid.current = true;
    setReplace({ rev: rev.current, graph: graph ?? emptyGraph(now.current?.graphId ?? '') });
    setHighlight(undefined);
  }, []);
  /** A new canvas session (another graph opened) — nothing pending from the old one may land on it. */
  const reset = useCallback(() => {
    now.current = null;
    laidRef.current = null;
    awaitingLaid.current = false;
    setReplace(undefined);
    setHighlight(undefined);
    setLabels({});
    setSteps(undefined);
  }, []);

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(undefined), highlightMs);
    return () => clearTimeout(timer);
  }, [highlight, highlightMs]);

  return { replace, highlight, labels, steps, onChange, current, laid, apply, restore, reset };
}
