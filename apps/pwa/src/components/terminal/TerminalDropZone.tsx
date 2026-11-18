'use client';

// WT-N-2 — drag-drop attach overlay for /term page.
//
// Listens for `dragenter` / `dragover` / `dragleave` / `drop` on the
// page-level container and shows a translucent overlay with an upload
// icon when files are being dragged. On drop, uploads each file in
// parallel via `uploadAttachments`.
//
// Why drag-drop on /term specifically: matches the desktop user's
// muscle-memory of "drop file into terminal pane to attach", and on
// touch devices (iPad with Magic Keyboard + trackpad) drag from
// Files.app split-screen also fires DataTransfer.files.
//
// The overlay is `pointer-events: none` until a drag is active so it
// doesn't intercept normal mouse/keyboard events on xterm.js.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { toast } from 'sonner';
import { debugLog } from '@/lib/debug';
import { uploadAttachments, type AttachmentMeta } from '@/lib/upload-attachment';
import { NEXUS_URL_MISSING } from '@/lib/nexus-url-missing';

interface Props {
  onAttached?: (entries: AttachmentMeta[]) => void;
  /** When true, the listener attaches to `document` (page-wide drop).
   *  When false (default), caller wraps the zone manually around the
   *  region that should accept drops. */
  pageWide?: boolean;
}

export function TerminalDropZone({ onAttached, pageWide = true }: Props) {
  const { config } = useDaemon();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  // Drag enter/leave fires for every child element — using a counter
  // avoids the overlay flickering when the user moves over inner DOM.
  const dragCounter = useRef(0);

  const handleDrop = useCallback(async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    if (!config.baseUrl) {
      toast.error(NEXUS_URL_MISSING);
      return;
    }
    setBusy(true);
    debugLog('webterm.dropzone.drop', {
      count: files.length,
      totalBytes: files.reduce((acc, f) => acc + f.size, 0),
    });
    try {
      const results = await uploadAttachments(
        files.map((file) => ({ file, filename: file.name })),
        {
          baseUrl: config.baseUrl,
          ...(config.token ? { token: config.token } : {}),
        },
      );
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      if (successes.length > 0) {
        toast.success(
          successes.length === 1
            ? `📎 ${(successes[0] as { meta: AttachmentMeta }).meta.filename}`
            : `📎 ${successes.length} files dropped`,
        );
        onAttached?.(successes.map((r) => (r as { meta: AttachmentMeta }).meta));
      }
      if (failures.length > 0) {
        toast.error(
          failures.length === 1
            ? `드롭 실패: ${(failures[0] as { reason: string }).reason.slice(0, 80)}`
            : `${failures.length} 파일 드롭 실패`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [config.baseUrl, config.token, onAttached]);

  useEffect(() => {
    if (!pageWide) return undefined;

    const onDragEnter = (ev: DragEvent): void => {
      if (!ev.dataTransfer || !ev.dataTransfer.types.includes('Files')) return;
      ev.preventDefault();
      dragCounter.current += 1;
      setDragging(true);
    };
    const onDragOver = (ev: DragEvent): void => {
      if (!ev.dataTransfer || !ev.dataTransfer.types.includes('Files')) return;
      ev.preventDefault();
    };
    const onDragLeave = (ev: DragEvent): void => {
      if (!ev.dataTransfer || !ev.dataTransfer.types.includes('Files')) return;
      ev.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragging(false);
    };
    const onDropEv = (ev: DragEvent): void => {
      if (!ev.dataTransfer) return;
      const list = ev.dataTransfer.files;
      if (!list || list.length === 0) return;
      ev.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      void handleDrop(Array.from(list));
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDropEv);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDropEv);
    };
  }, [handleDrop, pageWide]);

  if (!dragging && !busy) return null;

  return (
    <div
      // pointer-events-none lets click events pass through xterm.js
      // even when the overlay is briefly mounted.
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/20 backdrop-blur-sm"
    >
      <div className="rounded-xl border-2 border-dashed border-primary bg-card px-6 py-4 text-center shadow-lg">
        <Upload className="mx-auto h-10 w-10 text-primary" aria-hidden />
        <div className="mt-2 text-sm font-medium text-foreground">
          {busy ? '업로드 중…' : 'Drop files to attach'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {busy ? '' : 'iCloud · Files.app · 폴더 모두 지원'}
        </div>
      </div>
    </div>
  );
}
