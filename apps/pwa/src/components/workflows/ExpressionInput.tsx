'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import type { WorkflowDefinitionLike } from './workflow-graph-layout';
import { getExpressionCandidates, variableLabel } from './expression-completion';

type ExpressionInputProps = {
  definition: WorkflowDefinitionLike;
  nodeId: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  className?: string;
  spellCheck?: boolean;
  placeholder?: string;
  rows?: number;
  multiline?: boolean;
};

export function cursorFragment(value: string, cursor: number | null): { start: number; typed: string } | null {
  if (cursor === null) return null;
  const before = value.slice(0, cursor);
  const match = /\$[A-Za-z0-9_.-]*$/.exec(before);
  if (!match) return null;
  const start = cursor - match[0].length;
  if (start > 0 && /[\\$]/.test(value[start - 1])) return null;
  return { start, typed: match[0] };
}

/** The text after choosing `candidate` for the `$…` fragment that ends at the cursor, and where the cursor goes. */
export function insertCandidate(
  value: string, selectionStart: number, selectionEnd: number, candidate: string,
): { value: string; cursor: number } | null {
  const part = cursorFragment(value, selectionStart);
  if (!part) return null;
  return { value: value.slice(0, part.start) + candidate + value.slice(selectionEnd), cursor: part.start + candidate.length };
}

export function insertAtSelection(
  value: string, start: number, end: number, text: string,
): { value: string; cursor: number } {
  return { value: value.slice(0, start) + text + value.slice(end), cursor: start + text.length };
}

export function ExpressionInput({
  definition, nodeId, value, onChange, className, spellCheck, placeholder, rows, multiline = false,
}: ExpressionInputProps) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const nextCursor = useRef<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [variableOpen, setVariableOpen] = useState(false);
  const fragment = dismissed ? null : cursorFragment(value, cursor);
  const candidates = fragment && !variableOpen ? getExpressionCandidates(definition, nodeId, fragment.typed) : [];
  const variables = variableOpen ? getExpressionCandidates(definition, nodeId, '$') : [];

  useEffect(() => {
    if (!variableOpen || typeof document === 'undefined') return;
    const outside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setVariableOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setVariableOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [variableOpen]);

  const rememberSelection = (el: HTMLInputElement | HTMLTextAreaElement) => {
    selectionRef.current = { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length };
  };

  useLayoutEffect(() => {
    if (nextCursor.current === null || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(nextCursor.current, nextCursor.current);
    nextCursor.current = null;
  }, [value]);

  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    rememberSelection(event.target);
    setCursor(event.target.selectionStart);
    setDismissed(false);
    setActiveIndex(0);
    onChange(event);
  };

  const applyInsertion = (inserted: { value: string; cursor: number }) => {
    const el = inputRef.current;
    if (!el) return;
    const { value: updated, cursor: position } = inserted;
    const setter = Object.getOwnPropertyDescriptor(
      multiline ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value',
    )?.set;
    if (!setter) return;
    nextCursor.current = position;
    setter.call(el, updated);
    // Call the parent directly: a DOM 'input' event dispatched from inside React's own keydown/click handler is not
    // turned into onChange, so the controlled value snapped back (live check · W5b harvest). Parents read target.value.
    onChange({ target: el, currentTarget: el, type: 'change', nativeEvent: new Event('input'),
      preventDefault: () => {}, stopPropagation: () => {} } as unknown as ChangeEvent<HTMLInputElement | HTMLTextAreaElement>);
    setCursor(position);
    selectionRef.current = { start: position, end: position };
    setDismissed(true);
  };

  const choose = (candidate: string) => {
    const el = inputRef.current;
    const selection = el?.selectionStart ?? cursor;
    if (!el || selection === null) return;
    const inserted = insertCandidate(value, selection, el.selectionEnd ?? selection, candidate);
    if (inserted) applyInsertion(inserted);
  };

  const chooseVariable = (candidate: string) => {
    const selection = selectionRef.current ?? { start: value.length, end: value.length };
    applyInsertion(insertAtSelection(value, selection.start, selection.end, candidate));
    setVariableOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && variableOpen) {
      event.preventDefault();
      setVariableOpen(false);
    } else if (event.key === 'Escape' && candidates.length) {
      event.preventDefault();
      setDismissed(true);
    } else if (candidates.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActiveIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length);
    } else if (candidates.length && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      choose(candidates[Math.min(activeIndex, candidates.length - 1)]);
    }
  };

  const shared = {
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => { inputRef.current = el; },
    value,
    spellCheck,
    className,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': candidates.length > 0,
  };

  return (
    <span ref={rootRef} className="relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-1">
      {multiline
        ? <textarea {...shared} rows={rows} placeholder={placeholder}
            onChange={handleChange} onKeyDown={handleKeyDown}
            onFocus={(event) => { rememberSelection(event.target); setCursor(event.target.selectionStart); }}
            onSelect={(event) => { rememberSelection(event.currentTarget); setCursor(event.currentTarget.selectionStart); }}
            onBlur={() => setCursor(null)} onClick={() => setDismissed(false)} />
        : <input {...shared} type="text" placeholder={placeholder}
            onChange={handleChange} onKeyDown={handleKeyDown}
            onFocus={(event) => { rememberSelection(event.target); setCursor(event.target.selectionStart); }}
            onSelect={(event) => { rememberSelection(event.currentTarget); setCursor(event.currentTarget.selectionStart); }}
            onBlur={() => setCursor(null)} onClick={() => setDismissed(false)} />}
      <button
        type="button"
        aria-label="변수 넣기"
        aria-haspopup="listbox"
        aria-expanded={variableOpen}
        className="rounded px-1.5 py-0.5 text-xs whitespace-nowrap bg-surface-elevated text-foreground border border-border hover:bg-surface"
        onMouseDown={(event) => { if (!variableOpen && inputRef.current) rememberSelection(inputRef.current); event.preventDefault(); }}
        onClick={() => {
          if (!variableOpen && inputRef.current && !selectionRef.current) rememberSelection(inputRef.current);
          setVariableOpen((open) => !open);
        }}
      >변수 넣기</button>
      {variableOpen && (
        <span role="listbox" aria-label="사용 가능한 변수" className="absolute left-0 top-full z-30 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-surface-elevated shadow-lg">
          {variables.length === 0 ? <span className="block px-2 py-1 text-xs">쓸 수 있는 변수가 없습니다</span> : variables.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full px-2 py-1 text-left text-xs hover:bg-surface"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseVariable(candidate)}
            ><span className="font-mono">{candidate}</span> · {variableLabel(candidate)}</button>
          ))}
        </span>
      )}
      {candidates.length > 0 && (
        <span role="listbox" aria-label="Expression suggestions" className="absolute left-0 top-full z-20 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-surface-elevated shadow-lg">
          {candidates.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`block w-full px-2 py-1 text-left font-mono text-xs hover:bg-surface ${index === activeIndex ? 'bg-surface' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(candidate)}
            >{candidate}</button>
          ))}
        </span>
      )}
    </span>
  );
}
