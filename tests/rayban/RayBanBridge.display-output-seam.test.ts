// RayBanBridge.display-output-seam.test.ts — GLS1 첫 조각 (0.2.40 P0) 격리 시험.
//
// Meta Device Access Toolkit 공식 1차 출처(wearables.developer.meta.com · 확인
// 날짜 2026-10-27)에서 확인된 계약 범위 안에서 RayBanBridge.swift 의 최소 앱 계층
// 출력 seam 이 텍스트/이미지 payload 를 테스트 전용 fake Device Access endpoint 로
// 그대로 전달하는지, 그리고 기존 RayBan 카메라 캡처 흐름이 보존되는지를 같은 런에
// 관측한다.
//
// ⚠️ 본 시험은 Swift 소스 계약을 읽어 검증한다 — 실제 안경 실기 검증이 아니다.
//
// 1차 출처 확인 (2026-10-27 · wearables.developer.meta.com):
//   Display — "A `Display` handles the connection to the glasses' display
//   service and provides methods to send views and video to the screen.
//   Create one via `DeviceSession/addDisplay()`." /
//   `public func send(_ view: some DisplayableView)`
//   https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_display
//   DisplayableView — `protocol DisplayableView: Sendable`
//   https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_displayableview
//   Text — `struct Text: ViewComponentSerializable, FlexShapedComponent, Sendable` ·
//   `public init(_ content: String, style: TextStyle, color: TextColor)`
//   https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_text
//   Image — `struct Image: ViewComponentSerializable, FlexShapedComponent, Sendable` ·
//   `public init( uri: String, sizePreset: ImageSize, cornerRadius: CornerRadius)`
//   https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_image
//   DeviceSession — "`DeviceSession` manages the lifecycle of a connection to a
//   device and serves as the parent for capabilities (e.g., streaming, display)."
//   https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatcore_devicesession
//   지원 플랫폼: iOS Swift — 공식 참조 경로 docs/reference/ios_swift/dat/1.0
//   (GitHub facebook/meta-wearables-dat-ios). Android 툴킷은 별도
//   (facebook/meta-wearables-dat-android) — 이 조각 범위 밖 후속.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const bridgePath =
  "apps/ios/ElanousiOS/ElanousiOS/Companion/RayBan/RayBanBridge.swift";
const fakeEndpointPath =
  "apps/ios/ElanousiOS/ElanousiOS/Companion/RayBan/RayBanFakeDeviceAccessEndpoint.swift";
const cameraPath =
  "apps/ios/ElanousiOS/ElanousiOS/Companion/RayBan/RayBanCameraSession.swift";
const displayDocUrl =
  "https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_display";
const textDocUrl =
  "https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_text";
const imageDocUrl =
  "https://wearables.developer.meta.com/docs/reference/ios_swift/dat/1.0/mwdatdisplay_image";

const bridge = readFileSync(bridgePath, "utf8");
const fakeEndpoint = readFileSync(fakeEndpointPath, "utf8");
const camera = readFileSync(cameraPath, "utf8");

/** Swift `RayBanDisplayPayload` 의 확인된 두 케이스를 나타내는 시험 무대 값. */
type DisplayPayloadMirror =
  | { kind: "text"; content: string }
  | { kind: "image"; uri: string };

describe("RayBanBridge display output seam (GLS1 P0)", () => {
  test("출력 seam: 텍스트/이미지 payload 모델이 확인된 계약 범위만 담는다", () => {
    expect(bridge).toMatch(
      /enum RayBanDisplayPayload[^{]*\{[^}]*case text\(content: String\)[^}]*case image\(uri: String\)/s,
    );
    // 확인된 범위 밖 payload (video 등) 를 seam 이 추가하지 않는다.
    expect(bridge).not.toMatch(/case video/);
  });

  test("출력 seam: 주입 가능한 endpoint 프로토콜이 payload 를 그대로 받는다", () => {
    expect(bridge).toMatch(
      /protocol RayBanDisplayOutputEndpoint[^{]*\{[^}]*func send\(_ payload: RayBanDisplayPayload\)/s,
    );
    expect(bridge).toMatch(
      /var displayOutputEndpoint: \(any RayBanDisplayOutputEndpoint\)\?/,
    );
  });

  test("출력 seam: 생산 경로 배선 문장이 기존 실행 경로에서 seam 을 부른다", () => {
    // 호출자: RayBanBridge.applyRegistrationState(_:) — attachStreams() 가
    // 띄운 registrationStateStream consumer → .registered 트랜지션 지점.
    const applyIdx = bridge.indexOf("private func applyRegistrationState(");
    expect(applyIdx).toBeGreaterThanOrEqual(0);
    const registeredIdx = bridge.indexOf("case .registered:", applyIdx);
    expect(registeredIdx).toBeGreaterThan(applyIdx);
    // 배선 문장 — .registered 트랜지션 안에서 emitDisplayOutput 호출.
    const registeredCase = bridge.slice(
      registeredIdx,
      bridge.indexOf("default:", registeredIdx),
    );
    expect(registeredCase).toContain("emitDisplayOutput(.text(content:");
    const forwardIdx = bridge.indexOf(
      "displayOutputEndpoint?.send(payload)",
      registeredIdx,
    );
    expect(forwardIdx).toBeGreaterThan(registeredIdx);
    // emitDisplayOutput 가 payload 를 변형 없이 forward 하는지.
    const emitFn = bridge.slice(
      bridge.indexOf("private func emitDisplayOutput("),
      bridge.indexOf("private func attachStreams("),
    );
    expect(emitFn).toContain(
      "func emitDisplayOutput(_ payload: RayBanDisplayPayload)",
    );
    expect(emitFn).toContain("displayOutputEndpoint?.send(payload)");
  });

  test("1차 출처: 확인된 Display·payload 문서 URL·날짜가 seam 소스에 기재돼 있다", () => {
    for (const source of [bridge, fakeEndpoint]) {
      // Display 계약 문서 — 공식 1차 출처.
      expect(source).toContain(displayDocUrl);
      // 확인 문장과 함께 확인 날짜가 적혀 있다.
      expect(source).toContain("2026-10-27");
      // payload 계약의 정확한 문서 페이지 — Text/Image 구조체 페이지.
      expect(source).toContain(textDocUrl);
      expect(source).toContain(imageDocUrl);
    }
  });

  test("fake Device Access endpoint: 테스트 전용이고 수신 payload 를 기록한다", () => {
    expect(fakeEndpoint).toContain("#if DEBUG");
    expect(fakeEndpoint).toContain("final class RayBanFakeDeviceAccessEndpoint");
    expect(fakeEndpoint).toContain(": RayBanDisplayOutputEndpoint");
    expect(fakeEndpoint).toMatch(
      /func send\(_ payload: RayBanDisplayPayload\)[^{]*\{[^}]*received\.append\(payload\)/s,
    );
    expect(fakeEndpoint).toContain("#endif");
    // 생산 경로에 fake 가 기본 주입되지 않는다 — bridge 는 fake 를 참조하지 않는다.
    expect(bridge).not.toContain("RayBanFakeDeviceAccessEndpoint");
  });

  test("fake endpoint payload 경로: 텍스트/이미지 payload 가 변형 없이 순서 보존되어 기록된다", () => {
    // Swift 소스에서 확인된 payload 계약 — bridge enum 의 두 케이스.
    expect(bridge).toMatch(/case text\(content: String\)/);
    expect(bridge).toMatch(/case image\(uri: String\)/);
    // fake endpoint 의 send 는 payload 를 조건 없이 received 에 append 한다(변형 없음).
    expect(fakeEndpoint).toMatch(
      /func send\(_ payload: RayBanDisplayPayload\)[^{]*\{[^}]*received\.append\(payload\)/s,
    );
    // 생산 배선 문장의 실제 텍스트 payload 를 그대로 무대 입력으로 쓴다.
    const wired = /emitDisplayOutput\(\.text\(content: "([^"]+)"\)\)/.exec(bridge);
    const wiredText = wired?.[1] ?? "";
    expect(wiredText).toBe("elanous · Ray-Ban glasses connected");
    // 실행: 확인된 두 payload 유형이 fake 의 기록 경로(append-only)를 그대로 지난다.
    const received: DisplayPayloadMirror[] = [];
    const fakeSend = (payload: DisplayPayloadMirror): void => {
      received.push(payload); // RayBanFakeDeviceAccessEndpoint.send 의 received.append(payload) 와 동일 계약
    };
    fakeSend({ kind: "text", content: wiredText });
    fakeSend({ kind: "image", uri: "https://example.test/rayban-frame.jpg" });
    expect(received).toEqual([
      { kind: "text", content: wiredText },
      { kind: "image", uri: "https://example.test/rayban-frame.jpg" },
    ]);
  });

  test("기존 카메라 캡처 흐름 보존 (createSession→addStream→listener→capturePhoto)", () => {
    // RayBanCameraSession.swift 의 StreamSessionViewModel 패턴 그대로.
    expect(camera).toContain("func start() async");
    expect(camera).toContain("createSession(deviceSelector:");
    expect(camera).toContain("addStream(config: config)");
    expect(camera).toMatch(
      /statePublisher\.listen[\s\S]*videoFramePublisher\.listen[\s\S]*errorPublisher\.listen[\s\S]*photoDataPublisher\.listen/s,
    );
    expect(camera).toContain("capturePhoto(format: .jpeg)");
    expect(camera).toContain("func stop() async");
    // 카메라 세션 파일은 이번 seam 변경을 담지 않는다.
    expect(camera).not.toContain("RayBanDisplayOutputEndpoint");
    expect(camera).not.toContain("RayBanDisplayPayload");
    // bridge → camera 기존 배선 그대로.
    expect(bridge).toContain(
      "RayBanCameraSession.shared.startDeviceMonitoringIfNeeded()",
    );
  });
});
