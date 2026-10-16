// 안드로이드 Gradle 빌드를 «실제로» 돌리는 시험의 전제 — JDK ⊕ Android SDK.
//
// ⛔ 0.2.20 컷(리눅스 게이트 Pod)에서 두 시험이 «JAVA_HOME is not set» 으로 빨갛게 떴다.
//    Pod 이미지에는 JDK·Android SDK 가 없고, 넣으려면 SDK·Gradle 의존을 네트워크로 받아야 한다
//    (게이트 Pod 의 몫이 아니다). macOS 개발 기계·`bun run test:android` 경로는 그대로 돈다.
// ⇒ 전제가 «없을 때만» 건너뛰고, 그 이유를 한 줄로 남긴다(조용한 skip 금지).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function resolveJavaHome(): string | undefined {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  for (const args of [['-v', '17'], []]) {
    const probe = spawnSync('/usr/libexec/java_home', args, { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return undefined;
}

export function resolveAndroidSdkDir(): string {
  return process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Library/Android/sdk');
}

/** 없는 전제를 사람이 읽을 문장으로 준다. 다 있으면 null. */
export function androidToolchainMissing(): string | null {
  const missing: string[] = [];
  const javaOnPath = spawnSync('java', ['-version'], { encoding: 'utf8' }).status === 0;
  if (!resolveJavaHome() && !javaOnPath) missing.push('JDK(JAVA_HOME·java_home·PATH 의 java 모두 없음)');
  const sdk = resolveAndroidSdkDir();
  if (!existsSync(sdk)) missing.push(`Android SDK(${sdk} 없음)`);
  return missing.length ? missing.join(' · ') : null;
}
