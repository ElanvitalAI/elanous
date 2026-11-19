'use client';

// WT-N-2 — Files.app multi-file attach.
//
// `<input type="file" multiple>` (no `capture` attr) opens:
//   - iOS Safari: Files.app picker with iCloud Drive · Locations · etc.
//   - desktop: native OS file dialog
// The user can pick N files at once; each is uploaded in parallel via
// `uploadAttachments`. Toast summarises N successes / failures.
//
// Sibling to WT-N-1's CameraAttachButton — same toolbar, different
// affordance. Camera: single image from sensor. Files: multi-file
// from any source the OS exposes.

import { useRef, useState } from 'react';
import { FilePlus2, Loader2 } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { toast } from 'sonner';
import { debugLog } from '@/lib/debug';
import { uploadAttachments, type AttachmentMeta } from '@/lib/upload-attachment';
import { NEXUS_URL_MISSING } from '@/lib/nexus-url-missing';
import { extractPickedFiles } from '@/lib/chat-paste-drop';

interface Props {
  onAttached?: (entries: AttachmentMeta[]) => void;
  chatLimits?: boolean;
}

export function FileAttachButton({ onAttached, chatLimits = false }: Props) {
  const { config } = useDaemon();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPick = async (ev: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const list = ev.target.files;
    ev.target.value = '';
    if (!list || list.length === 0) return;
    if (!config.baseUrl) {
      toast.error(NEXUS_URL_MISSING);
      return;
    }
    const picked = Array.from(list);
    const selected = chatLimits ? extractPickedFiles(picked) : { files: picked.map(file => ({ file, filename: file.name })), tooLarge: 0, tooMany: 0 };
    if (selected.tooLarge) toast.error(`파일당 최대 10MiB입니다 · ${selected.tooLarge}개 제외`);
    if (selected.tooMany) toast.error(`한 번에 최대 10개입니다 · ${selected.tooMany}개 제외`);
    if (!selected.files.length) return;
    setBusy(true);
    const files = selected.files.map(entry => entry.file);
    debugLog('webterm.files.pick', {
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
            : `📎 ${successes.length} files attached`,
        );
        onAttached?.(successes.map((r) => (r as { meta: AttachmentMeta }).meta));
      }
      if (failures.length > 0) {
        toast.error(
          failures.length === 1
            ? `업로드 실패: ${(failures[0] as { reason: string }).reason.slice(0, 80)}`
            : `${failures.length} 파일 업로드 실패`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label="attach files"
        title="attach files (Files.app · iCloud · multi-select)"
        className="flex min-h-11 min-w-11 items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus2 className="h-3.5 w-3.5" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPick}
      />
    </>
  );
}
