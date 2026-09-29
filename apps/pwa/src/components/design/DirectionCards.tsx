'use client';

// RFC design loop §B — design directions as cards you can pick.
//
// Pure props, no react-query: the panel owns the mutation and passes `onPick`,
// so a test can drive a real click without a daemon.
//
// ⛔ Every colour on a card comes from the daemon's swatch — the panel never
//    invents one, so a system or theme edit shows up here without a second
//    place to update.

import { CheckCircle2 } from 'lucide-react';
import type { DesignDirectionView } from '@/nexus/client';
import { groupDirections } from '@/nexus/hooks/use-design-check';

export interface DirectionCardsProps {
  available: readonly DesignDirectionView[];
  declared: string | null;
  onPick: (id: string) => void;
  /** The id being written right now — its button shows progress, all buttons wait. */
  pendingId: string | null;
  /** System ids that have an HTML preview. Cards outside this set show no Preview button. */
  previews?: ReadonlySet<string>;
  /** Opens the sandboxed preview for that id. */
  onPreview?: (id: string) => void;
}

export function DirectionCards({ available, declared, onPick, pendingId, previews, onPreview }: DirectionCardsProps) {
  const { systems, themes } = groupDirections(available);
  return (
    <div className="space-y-4">
      {systems.length > 0 && (
        <CardGroup
          title="Design systems"
          hint="Web · copies tokens.css and DESIGN.md into design/system/"
          items={systems}
          declared={declared}
          onPick={onPick}
          pendingId={pendingId}
          previews={previews}
          onPreview={onPreview}
        />
      )}
      {themes.length > 0 && (
        <CardGroup
          title="Terminal themes"
          hint="One line in DESIGN.md"
          items={themes}
          declared={declared}
          onPick={onPick}
          pendingId={pendingId}
          previews={previews}
          onPreview={onPreview}
        />
      )}
    </div>
  );
}

function CardGroup({
  title,
  hint,
  items,
  declared,
  onPick,
  pendingId,
  previews,
  onPreview,
}: {
  title: string;
  hint: string;
  items: readonly DesignDirectionView[];
  declared: string | null;
  onPick: (id: string) => void;
  pendingId: string | null;
  previews?: ReadonlySet<string>;
  onPreview?: (id: string) => void;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="normal-case tracking-normal">{items.length} · {hint}</span>
      </h3>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((d) => (
          <DirectionCard
            key={d.id}
            direction={d}
            chosen={d.id === declared}
            onPick={onPick}
            pending={pendingId === d.id}
            busy={pendingId !== null}
            hasPreview={previews?.has(d.id) === true && onPreview !== undefined}
            onPreview={onPreview}
          />
        ))}
      </ul>
    </section>
  );
}

function DirectionCard({
  direction: d,
  chosen,
  onPick,
  pending,
  busy,
  hasPreview,
  onPreview,
}: {
  direction: DesignDirectionView;
  chosen: boolean;
  onPick: (id: string) => void;
  pending: boolean;
  busy: boolean;
  hasPreview: boolean;
  onPreview?: (id: string) => void;
}) {
  const bg = d.swatch.bg ?? (d.isDark ? '#111111' : '#ffffff');
  const fg = d.swatch.fg ?? d.swatch.text;
  const fonts = d.typography?.display ?? d.typography?.body ?? null;
  return (
    <li
      data-direction={d.id}
      data-direction-id={d.id}
      className={`flex flex-col gap-2 rounded-md border p-3 text-sm ${chosen ? 'border-primary ring-1 ring-primary' : ''}`}
    >
      <div className="flex items-center gap-1.5" aria-hidden>
        {[bg, fg, d.swatch.accent].map((colour, i) => (
          <span
            key={i}
            className="h-5 w-5 rounded-full border"
            style={{ backgroundColor: colour, borderColor: d.swatch.muted }}
          />
        ))}
        {d.category && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground">{d.category}</span>
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate font-medium">{d.label ?? d.id}</p>
        <p className="truncate text-xs text-muted-foreground"><code>{d.id}</code>{fonts ? ` · ${fonts}` : ''}</p>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.mood}</p>
      </div>
      <div className="flex items-center gap-2">
        {hasPreview && (
          <button
            type="button"
            onClick={() => onPreview?.(d.id)}
            className="self-start rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
            aria-label={`Preview ${d.label ?? d.id}`}
          >
            Preview
          </button>
        )}
        {chosen ? (
          <span className="inline-flex items-center gap-1 text-xs text-primary">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            Selected
          </span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(d.id)}
            className="self-start rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
            aria-label={`Select ${d.label ?? d.id}`}
          >
            {pending ? 'Selecting…' : 'Select'}
          </button>
        )}
      </div>
    </li>
  );
}
