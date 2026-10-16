// 판정 본체는 `scripts/lib/android-toolchain.ts` 로 옮겼다 — android-gate(`scripts/ci-android-unit-tests.ts`)가
// 시험과 «같은 판정»을 쓰도록(R5a · 0.2.31). 시험들의 기존 import 경로는 그대로 둔다.
export { androidToolchainMissing, resolveAndroidSdkDir, resolveJavaHome } from '../../scripts/lib/android-toolchain';
