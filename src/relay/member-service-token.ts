import { readFileSync, statSync } from "node:fs";

/*
 * (출처: #39104) JUD must ⓑ1 수리 — relay «회원 서버 역할» 서비스 토큰(ems_).
 * 회원 서버는 이 자격으로 «아무 회원의 핸들 핀 여부 불리언 읽기»만 질의한다
 * (쓰기는 0). 토큰 회전 경로는 env(ELANOUS_RELAY_MEMBER_SERVICE_TOKEN) 또는
 * 0600 권한 파일(ELANOUS_RELAY_MEMBER_SERVICE_TOKEN_FILE)이고, 파일 권한이
 * 0600 이 아니면 거부한다(그룹·기타 읽기 허용은 시크릿 유출).
 */

/** (출처: #39104) 서비스 토큰 형식 — ems_ 접두 단일 시크릿(24자 이상). */
export const MEMBER_SERVICE_TOKEN_PATTERN = /^ems_[A-Za-z0-9_-]{24,}$/;

/** (출처: #39104) 상수시간 문자열 대조 — 토큰 스캔 회귀 방지. */
export function constantTimeTokenEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1)
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return diff === 0;
}

/** (출처: #39104) 0600 파일에서 서비스 토큰을 읽는다(그 외 권한은 거부). */
export function readMemberServiceTokenFile(path: string): string {
  const stat = statSync(path);
  if (stat.isFile() && stat.mode & 0o077)
    throw new Error("member service token file must be mode 0600");
  return readFileSync(path, "utf8");
}

/** (출처: #39104) env → 0600 파일 회전 해석(둘 다 없으면 undefined). */
export function resolveMemberServiceToken(
  environmentValue: string | undefined = process.env
    .ELANOUS_RELAY_MEMBER_SERVICE_TOKEN,
  filePath: string | undefined = process.env
    .ELANOUS_RELAY_MEMBER_SERVICE_TOKEN_FILE,
): string | undefined {
  const raw =
    environmentValue !== undefined && environmentValue.trim() !== ""
      ? environmentValue
      : filePath !== undefined && filePath.trim() !== ""
        ? readMemberServiceTokenFile(filePath.trim())
        : undefined;
  const token = raw?.trim();
  if (token === undefined || token === "") return undefined;
  if (!MEMBER_SERVICE_TOKEN_PATTERN.test(token))
    throw new Error("member service token must match ems_[A-Za-z0-9_-]{24,}");
  return token;
}
