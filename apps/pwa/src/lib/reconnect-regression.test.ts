// 출처: #39459 JUD-B #124629 기능 HOLD — «다시 연결»(reconnect)이 레거시
// elanous.voice.token 까지 제거·복원 차단해야 재로드 뒤에도 토큰이 빈 채로
// 남는다. 단언은 JUD-B 의 node-b 합성 저장소 독립 재실행본(1 pass/1 fail)을
// 그대로 채택하고, 파일 단위 global 정리만 붙인다(타 시험 파일 오염 방지).
import { afterEach, test, expect } from "bun:test";
import { reconnectRejectedDevice } from "../components/chat/ChatErrorBoundary";
import { loadDaemonConfig } from "./daemon-config";

type MaybeGlobal = { window?: unknown; localStorage?: Storage };
const g = globalThis as unknown as MaybeGlobal;
const prevWindow = g.window;
const prevLocalStorage = g.localStorage;

afterEach(() => {
  if (prevWindow === undefined) delete g.window;
  else g.window = prevWindow;
  if (prevLocalStorage === undefined) delete g.localStorage;
  else g.localStorage = prevLocalStorage;
});

test("reconnect clears a migrated legacy token across reload", () => {
  const m = new Map<string,string>([["elanous.daemon.token", "fake-rejected"], ["elanous.voice.token", "fake-rejected"]]);
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => {m.set(k,v)}, removeItem: (k: string) => {m.delete(k)} };
  let reloaded = false;
  Object.assign(globalThis, { localStorage: storage, window: { location: { protocol: "http:", host: "fake.invalid", reload: () => { reloaded = true; } } } });
  reconnectRejectedDevice();
  expect(reloaded).toBe(true);
  expect(m.get("elanous.daemon.token")).toBe("");
  expect(loadDaemonConfig().token).toBe("");
});
test("control: reconnect stays empty when legacy token absent", () => {
  const m = new Map<string,string>([["elanous.daemon.token", "fake-rejected"]]);
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => {m.set(k,v)}, removeItem: (k: string) => {m.delete(k)} }, window: { location: { protocol: "http:", host: "fake.invalid", reload: () => {} } } });
  reconnectRejectedDevice();
  expect(loadDaemonConfig().token).toBe("");
});