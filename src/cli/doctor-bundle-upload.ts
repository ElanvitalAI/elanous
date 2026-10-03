import { readFileSync, statSync } from 'node:fs';
import { debug } from '../debug/log.js';

export interface DoctorBundleUploadOptions {
  path: string;
  files: readonly string[];
  uploadUrl?: string;
  confirm: (message: string) => Promise<boolean>;
  fetch: typeof globalThis.fetch;
  yes?: boolean;
  /** Present the inventory before either consent or transport; JSON callers can use stderr. */
  announce?: (contents: string) => void;
  /** Pass the size returned by buildDoctorBundle, if available. */
  bytes?: number;
}

export interface DoctorBundleUploadResult {
  path: string;
  uploaded: boolean;
  code?: string;
  reason?: string;
  exitCode: number;
  message: string;
}

/** The bundle is local until both an HTTPS destination and affirmative consent exist. */
export async function uploadDoctorBundle({ path, files, uploadUrl, confirm, fetch, yes = false, bytes, announce = console.log }: DoctorBundleUploadOptions): Promise<DoctorBundleUploadResult> {
  const size = bytes ?? (() => { try { return statSync(path).size; } catch { return undefined; } })();
  const skipped = (reason: string, message: string): DoctorBundleUploadResult => {
    debug.log('doctor.bundle', 'upload-skipped', { bytes: size, reason });
    return { path, uploaded: false, reason, exitCode: 0, message };
  };
  if (!uploadUrl?.trim()) return skipped('no-recipient', `수신처가 아직 정해지지 않았습니다 — 파일을 지원에 직접 보내 주세요: ${path}`);
  let destination: URL;
  try {
    destination = new URL(uploadUrl.trim());
    if (destination.protocol !== 'https:' || !destination.hostname || destination.username || destination.password) throw new Error('invalid destination');
  } catch {
    return skipped('invalid-recipient', `수신처가 유효한 HTTPS 주소가 아닙니다 — 파일을 지원에 직접 보내 주세요: ${path}`);
  }
  const contents = `내용 목록 (${size === undefined ? '크기 확인 불가' : `${size} bytes`}):\n${files.map((file) => `  ${file}`).join('\n')}`;
  announce(contents);
  if (!yes) {
    let agreed = false;
    try { agreed = await confirm('올릴까요? (y/N) '); } catch { /* An unavailable prompt is a refusal. */ }
    if (!agreed) {
      debug.log('doctor.bundle', 'declined', { bytes: size, reason: 'consent-declined' });
      return { path, uploaded: false, reason: 'consent-declined', exitCode: 0, message: `업로드하지 않았습니다: ${path}` };
    }
  }
  const failed = (reason: string): DoctorBundleUploadResult => {
    debug.log('doctor.bundle', 'upload-failed', { bytes: size, reason });
    return { path, uploaded: false, reason, exitCode: 1, message: `업로드 실패 (${reason}) — 파일: ${path} — 다시 시도해 주세요.` };
  };
  try {
    const response = await fetch(destination.href, {
      method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: readFileSync(path), redirect: 'manual',
    });
    if (!response.ok) return failed(`HTTP ${response.status}`);
    const data: unknown = await response.json();
    const code = data && typeof data === 'object' && !Array.isArray(data) ? (data as { code?: unknown }).code : undefined;
    if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(code)) return failed('진단 코드 응답이 올바르지 않습니다');
    debug.log('doctor.bundle', 'uploaded', { bytes: size, reason: 'success' });
    return { path, uploaded: true, code, exitCode: 0, message: `진단 코드: ${code} — 이 코드만 지원에 알려 주세요` };
  } catch {
    return failed('네트워크 또는 파일 읽기 오류');
  }
}
