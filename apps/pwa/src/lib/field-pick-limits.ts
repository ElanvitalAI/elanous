// PAR-EV10b — the same limits the daemon enforces (src/nexus/api/field-uploads.ts), checked before
// uploading so a person learns «why» instead of a failed request. iOS caps a pick at 20 items.
export const FIELD_MAX_FILES = 20;
export const FIELD_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const FIELD_MAX_REQUEST_BYTES = 250 * 1024 * 1024;

export interface FieldPick { kept: File[]; note: string | null }

/** Keep files in pick order until a limit is hit; say in one line what was left out and why. */
export function applyFieldPickLimits(files: readonly File[]): FieldPick {
  const kept: File[] = [];
  let tooBig = 0;
  let overTotal = 0;
  let overCount = 0;
  let total = 0;
  for (const file of files) {
    if (file.size > FIELD_MAX_FILE_BYTES) { tooBig += 1; continue; }
    if (kept.length >= FIELD_MAX_FILES) { overCount += 1; continue; }
    if (total + file.size > FIELD_MAX_REQUEST_BYTES) { overTotal += 1; continue; }
    kept.push(file);
    total += file.size;
  }
  const reasons = [
    tooBig ? `${tooBig}개는 한 개가 100MB 를 넘습니다` : '',
    overCount ? `${overCount}개는 한 번에 ${FIELD_MAX_FILES}개를 넘습니다` : '',
    overTotal ? `${overTotal}개는 합계 250MB 를 넘습니다` : '',
  ].filter(Boolean);
  const left = tooBig + overCount + overTotal;
  return { kept, note: left ? `${left}개는 빠집니다 — ${reasons.join(' · ')}` : null };
}
