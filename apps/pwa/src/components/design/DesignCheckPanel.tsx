'use client';

// B4 — craft rulebook panel. `/design-check` route.
//
// Renders the verdict `elanous repo design-check` prints, for the repository the
// daemon is watching: which craft rulebooks the DESIGN.md declares, which of
// those cannot be found, and — the part only this surface can show — which
// rulebooks elanous ships that the document has NOT declared.
//
// Backed by GET /v1/design-check (30s refetch). Pure read.
//
// ⛔ The panel deliberately renders a BLOCKED verdict as content, not as an
//    error state. "elanous's craft directory is unreadable" and "your DESIGN.md
//    declares a rulebook that does not exist" are different problems with
//    different fixes; showing a generic "failed to load" for either one is the
//    exact collapse this whole axis exists to undo.

import { AlertTriangle, BookOpen, CheckCircle2, CircleDashed, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import {
  describeBlocked,
  describeCreateFailure,
  describePickFailure,
  previewSystemSet,
  projectRulebookRows,
  useCreateDesignSystem,
  useDesignCheck,
  useDesignPreview,
  useDesignPreviews,
  useSetDesignDirection,
  type RulebookRowStatus,
} from '@/nexus/hooks/use-design-check';
import { DirectionCards } from './DirectionCards';
import { MakeMySystem } from './MakeMySystem';

const STATUS_LABEL: Record<RulebookRowStatus, string> = {
  missing: 'Missing',
  declared: 'Declared',
  available: 'Not declared',
};

const STATUS_CLASS: Record<RulebookRowStatus, string> = {
  missing: 'bg-error/10 text-error',
  declared: 'bg-green-600/10 text-green-700',
  available: 'bg-muted text-muted-foreground',
};

const STATUS_ICON = {
  missing: AlertTriangle,
  declared: CheckCircle2,
  available: CircleDashed,
} as const;

export function DesignCheckPanel() {
  const client = useOptionalNexusClient();
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 p-6">
        <h1 className="text-xl font-semibold tracking-tight">Design check</h1>
        <p className="text-sm text-muted-foreground">
          Connect to a NEXUS daemon to see this repository&apos;s craft rulebooks.
        </p>
      </div>
    );
  }
  return <DesignCheckPanelInner />;
}

function DesignCheckPanelInner() {
  const { data, isLoading, error, refetch, isFetching } = useDesignCheck();

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <BookOpen className="h-5 w-5" aria-hidden />
            Design check
          </h1>
          <p className="text-sm text-muted-foreground">
            Craft rulebooks declared by this repository&apos;s <code>DESIGN.md</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted"
          aria-label="Refresh design check"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {/* A transport failure is genuinely different from a blocked verdict:
          the daemon never answered. Say so plainly rather than reusing the
          blocked copy, which would misdirect the reader to their DESIGN.md. */}
      {error && (
        <p className="rounded-md bg-error/10 p-3 text-sm text-error">
          Could not reach the daemon: {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {data && data.ok === false && (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
            Design check blocked
          </p>
          <p className="text-sm text-muted-foreground">
            {describeBlocked(data.blockedOn, data.path)}
          </p>
        </div>
      )}

      {data && data.ok === true && <Verdict data={data} />}
    </div>
  );
}

function Verdict({ data }: { data: Extract<NonNullable<ReturnType<typeof useDesignCheck>['data']>, { ok: true }> }) {
  const rows = projectRulebookRows(data);
  const missingCount = data.unavailableRulebooks.length;

  return (
    <>
      <div
        className={`rounded-md p-3 text-sm ${missingCount ? 'bg-error/10 text-error' : 'bg-green-600/10 text-green-700'}`}
      >
        {missingCount
          ? `${missingCount} declared rulebook${missingCount === 1 ? '' : 's'} could not be found.`
          : `All ${data.declaredRulebooks.length} declared rulebook${data.declaredRulebooks.length === 1 ? '' : 's'} resolve.`}
      </div>

      <dl className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="truncate sm:col-span-2">
          <dt className="inline font-medium">Repository: </dt>
          <dd className="inline">
            <code>{data.repoRoot}</code>
            {data.repoSource && (
              <span className="ml-1">({data.repoSource === 'config' ? 'harness.defaultRepo' : 'daemon folder'})</span>
            )}
          </dd>
        </div>
        <div className="truncate">
          <dt className="inline font-medium">Document: </dt>
          <dd className="inline"><code>{data.documentPath}</code></dd>
        </div>
        <div className="truncate">
          <dt className="inline font-medium">Rulebooks: </dt>
          <dd className="inline"><code>{data.craftDirectory}</code></dd>
        </div>
      </dl>

      <Directions data={data} />

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          elanous ships no craft rulebooks and this document declares none.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((row) => {
            const Icon = STATUS_ICON[row.status];
            return (
              <li key={row.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex items-center gap-2 text-sm">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <code>{row.name}</code>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}>
                  {STATUS_LABEL[row.status]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** B5 — visual direction. Rendered BELOW the rulebooks and visually quieter:
 *  rulebooks are a contract (a missing one fails the check), a direction is a
 *  choice. Giving them equal weight would make "nobody picked yet" read as a
 *  problem on every freshly scaffolded project.
 *
 *  RFC design loop §B — the cards pick: one POST writes the same files the
 *  CLI `repo design-direction --set` writes, into the repository shown above. */
function Directions({ data }: { data: Extract<NonNullable<ReturnType<typeof useDesignCheck>['data']>, { ok: true }> }) {
  const pick = useSetDesignDirection();
  const create = useCreateDesignSystem();
  const previews = useDesignPreviews();
  const [openId, setOpenId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const dirs = data.directions;
  useEffect(() => {
    if (!highlightId || !dirs) return;
    const card = document.querySelector(`[data-direction-id="${highlightId.replace(/"/g, '')}"]`);
    card?.scrollIntoView({ block: 'nearest' });
  }, [highlightId, dirs]);
  if (!dirs) return null;
  const pendingId = pick.isPending ? (pick.variables ?? null) : null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Design direction</h2>
      <MakeMySystem
        pending={create.isPending}
        result={create.data ?? null}
        error={create.isError ? describeCreateFailure(create.error) : null}
        onCreate={(body) => {
          create.mutate(body, {
            onSuccess: (made) => setHighlightId(made.id),
          });
        }}
        onSelect={(id) => {
          setHighlightId(id);
          pick.mutate(id);
        }}
      />
      {dirs.unavailable && (
        <p className="rounded-md bg-error/10 p-2 text-sm text-error">
          Declared direction <code>{dirs.unavailable}</code> is not registered.
        </p>
      )}
      {dirs.declared === null && !dirs.unavailable && (
        <p className="text-sm text-muted-foreground">None declared — pick one below.</p>
      )}
      {pick.isError && (
        <p className="rounded-md bg-error/10 p-2 text-sm text-error">{describePickFailure(pick.error)}</p>
      )}
      {openId && (
        <PreviewFrame
          system={openId}
          onClose={() => setOpenId(null)}
          onSelect={() => pick.mutate(openId)}
          selecting={pendingId === openId}
          busy={pendingId !== null}
          alreadySelected={dirs.declared === openId}
        />
      )}
      <DirectionCards
        available={dirs.available}
        declared={dirs.declared}
        pendingId={pendingId}
        previews={previewSystemSet(previews.data?.previews)}
        onPreview={(id) => setOpenId(id)}
        onPick={(id) => pick.mutate(id)}
      />
    </section>
  );
}

/** Untrusted preview HTML. Empty sandbox — no scripts, no same-origin. */
function PreviewFrame({
  system,
  onClose,
  onSelect,
  selecting,
  busy,
  alreadySelected,
}: {
  system: string;
  onClose: () => void;
  onSelect: () => void;
  selecting: boolean;
  busy: boolean;
  alreadySelected: boolean;
}) {
  const preview = useDesignPreview(system);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Preview · <code>{system}</code></p>
        <div className="flex items-center gap-2">
          {alreadySelected ? (
            <span className="text-xs text-primary">Selected</span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onSelect}
              className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
              aria-label={`Select ${system}`}
            >
              {selecting ? 'Selecting…' : 'Select'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
            aria-label="Close preview"
          >
            Close
          </button>
        </div>
      </div>
      {preview.isLoading && <p className="text-sm text-muted-foreground">Loading preview…</p>}
      {preview.isError && (
        <p className="text-sm text-error">
          Could not load the preview: {preview.error instanceof Error ? preview.error.message : String(preview.error)}
        </p>
      )}
      {preview.data && (
        <iframe
          sandbox=""
          srcDoc={preview.data.html}
          title={`Preview · ${system}`}
          className="h-80 w-full rounded-md border bg-white"
        />
      )}
    </div>
  );
}
