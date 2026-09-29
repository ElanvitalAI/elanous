'use client';

// 카드 격자 맨 앞 한 칸. props 만 — 시험이 진짜 입력과 클릭을 몬다.
// 데몬 호출은 패널이 소유한다.

import { useState } from 'react';
import type { CreateDesignSystemBody, CreateDesignSystemResponse } from '@/nexus/client';

export interface MakeMySystemProps {
  onCreate: (body: CreateDesignSystemBody) => void;
  onSelect: (id: string) => void;
  pending: boolean;
  result: CreateDesignSystemResponse | null;
  error: string | null;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function parseColors(raw: string): string[] {
  return raw.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
}

function readField(id: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const node = document.getElementById(id);
  if (node && 'value' in node && typeof node.value === 'string') return node.value;
  return fallback;
}

export function MakeMySystem({ onCreate, onSelect, pending, result, error }: MakeMySystemProps) {
  const [tab, setTab] = useState<'url' | 'colors'>('url');
  const [url, setUrl] = useState('');
  const [colors, setColors] = useState('');
  const [id, setId] = useState('');
  const swatches = parseColors(colors).filter((color) => HEX.test(color));
  const colorCount = parseColors(colors).length;
  const colorsReady = colorCount >= 2 && colorCount <= 6 && id.trim().length > 0 && swatches.length === colorCount;

  return (
    <section className="rounded-md border p-3" aria-label="Make my system" data-make-my-system="">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Make my system</h3>
        <div className="flex gap-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'url'}
            className={`rounded-md px-2 py-1 text-xs ${tab === 'url' ? 'bg-muted' : ''}`}
            onClick={() => setTab('url')}
          >
            From a website
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'colors'}
            className={`rounded-md px-2 py-1 text-xs ${tab === 'colors' ? 'bg-muted' : ''}`}
            onClick={() => setTab('colors')}
          >
            From colors
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Reference, not a copy — logos, names, images and text are not taken.
      </p>

      {tab === 'url' ? (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const next = url.trim();
            if (!next || pending) return;
            onCreate({ kind: 'url', url: next });
          }}
        >
          <label className="sr-only" htmlFor="make-system-url">Website URL</label>
          <input
            id="make-system-url"
            type="url"
            value={url}
            disabled={pending}
            placeholder="https://example.com"
            onChange={(event) => setUrl(event.target.value)}
            className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const next = readField('make-system-url', url).trim();
              if (!next || pending) return;
              onCreate({ kind: 'url', url: next });
            }}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {pending ? 'Measuring…' : 'Make it'}
          </button>
        </form>
      ) : (
        <form
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!colorsReady || pending) return;
            onCreate({ kind: 'palette', colors: swatches, id: id.trim() });
          }}
        >
          <label className="block text-xs text-muted-foreground" htmlFor="make-system-colors">
            2–6 colors
          </label>
          <input
            id="make-system-colors"
            value={colors}
            disabled={pending}
            placeholder="#f4efe6, #1f3a2e, #c8553d"
            onChange={(event) => setColors(event.target.value)}
            className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
          />
          {swatches.length > 0 && (
            <ul className="flex gap-1" aria-label="Color preview">
              {swatches.map((color) => (
                <li
                  key={color}
                  className="h-6 w-6 rounded-sm border"
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </ul>
          )}
          <label className="block text-xs text-muted-foreground" htmlFor="make-system-id">id</label>
          <input
            id="make-system-id"
            value={id}
            disabled={pending}
            placeholder="stumptowncoffee"
            onChange={(event) => setId(event.target.value)}
            className="w-full rounded-md border bg-transparent px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const typed = parseColors(readField('make-system-colors', colors)).filter((color) => HEX.test(color));
              const nextId = readField('make-system-id', id).trim();
              if (pending || typed.length < 2 || typed.length > 6 || nextId.length === 0) return;
              onCreate({ kind: 'palette', colors: typed, id: nextId });
            }}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {pending ? 'Measuring…' : 'Make it'}
          </button>
        </form>
      )}

      {pending && <p className="mt-2 text-sm text-muted-foreground">Measuring…</p>}
      {error && <p className="mt-2 text-sm text-error" role="alert">{error}</p>}
      {result && (
        <div className="mt-2 space-y-1 text-sm">
          <p>Made {result.id} — {result.tokens.length} tokens · {result.unread} unread</p>
          {result.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">{warning}</p>
          ))}
          <button
            type="button"
            onClick={() => onSelect(result.id)}
            className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
          >
            Select it
          </button>
        </div>
      )}
    </section>
  );
}
