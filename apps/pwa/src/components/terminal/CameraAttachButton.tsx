'use client';

// WT-N-1 — single-shot camera/file attach.
//
// Renders a Camera icon button that opens an iOS Safari camera (or
// platform file picker on desktop) via `<input type="file" accept="image/*"
// capture="environment">`. On selection, the file is multipart-uploaded
// to daemon `POST /v1/attachments` and a toast confirms with the
// returned id. The id can later be referenced by chat / agent turns.
//
// Why a separate component: the button is reusable across surfaces
// (/term toolbar today, /chat composer tomorrow) and the
// `<input capture>` ergonomics differ enough from generic file pickers
// that hiding them behind a hook keeps each call site simple.

import { useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { toast } from 'sonner';
import { debugLog } from '@/lib/debug';
import { uploadAttachment, type AttachmentMeta } from '@/lib/upload-attachment';

interface Props {
  /** Optional callback when upload succeeds. Caller can promote the
   *  attachment id into a queue (e.g., next chat turn) or inject the
   *  daemon-host path into the active terminal. */
  onAttached?: (entry: AttachmentMeta) => void;
}

export function CameraAttachButton({ onAttached }: Props) {
  const { config } = useDaemon();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPick = async (ev: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = ev.target.files?.[0];
    // Reset the input so picking the same file twice in a row still
    // fires `onChange`.
    ev.target.value = '';
    if (!file) return;
    if (!config.baseUrl) {
      toast.error('Daemon URL 미설정 — Settings 에서 입력');
      return;
    }
    setBusy(true);
    debugLog('webterm.attach.pick', {
      filename: file.name,
      size: file.size,
      type: file.type,
    });
    try {
      const result = await uploadAttachment({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
        file,
        filename: file.name,
      });
      if (!result.ok) {
        debugLog('webterm.attach.error', { status: result.status, detail: result.reason.slice(0, 200) });
        toast.error(`업로드 실패 (${result.status})`);
        return;
      }
      const { meta } = result;
      debugLog('webterm.attach.ok', { id: meta.id, size: meta.size });
      toast.success(`📎 ${meta.filename} (${(meta.size / 1024).toFixed(1)} kB)`);
      onAttached?.(meta);
    } catch (e) {
      debugLog('webterm.attach.exception', { reason: String(e) });
      toast.error(`업로드 실패: ${String(e instanceof Error ? e.message : e)}`);
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
        aria-label="attach photo"
        title="attach photo (camera or file)"
        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
      </button>
      {/* iOS Safari opens the native camera UI when capture="environment"
          + accept image. Other browsers fall back to the file picker. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onPick}
      />
    </>
  );
}
