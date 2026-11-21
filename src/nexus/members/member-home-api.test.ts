import { expect, test } from "bun:test";
import { createMemberStore } from "./member-store.js";
import { createMembersApi } from "./members-api.js";

test("Google callback creates a session without an undelivered key and opens the authenticated home", async () => {
  const store = createMemberStore({ path: ":memory:" });
  try {
    const api = createMembersApi({
      store,
      google: {
        redirectUri:
          "https://api.example.test/v1/members/oauth/google/callback",
        complete: async () => ({
          identity: {
            sub: "new-member",
            email: "new@example.test",
            emailVerified: true,
            name: "New Member",
          },
          intent: { consents: { privacy: "v1", terms: "v1" } },
        }),
      } as never,
      successRedirectUri: "https://app.example.test/member",
      webOrigin: "https://app.example.test",
    });
    const callback = await api.handle(
      new Request(
        "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
        {
          headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
        },
      ),
    );
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get("location")).toBe(
      "https://app.example.test/member",
    );
    expect(await callback?.text()).not.toContain("Save your member key");
    const session = /__Host-elanous_member_session=([^;]+)/.exec(
      callback?.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(session).toBeTruthy();
    const member = store.memberForGoogleSub("new-member");
    expect(member).not.toBeNull();
    expect(store.listMemberKeys(member!.id)).toEqual([]);
    const homeUrl = "https://api.example.test/v1/members/home";
    expect((await api.handle(new Request(homeUrl)))?.status).toBe(401);
    const home = await api.handle(
      new Request(homeUrl, {
        headers: { cookie: `__Host-elanous_member_session=${session}` },
      }),
    );
    expect(home?.status).toBe(200);
    const body = await home!.text();
    expect(body).toContain("무료 멤버");
    expect(body).toContain("유료 멤버십은 2027년 2월 시작 예정입니다");
    expect(body).toContain("내 추천 링크 복사");
    expect(body).not.toContain("/app/connect");
    expect(body).toContain('class="brand" href="https://app.example.test/"');
    expect(body).not.toContain('href="https://app.example.test/app"');
    expect(body).not.toContain("/app/chat");
    expect(body).not.toContain("연결 상태를 아직 확인하지 못했어요");
    expect(body).not.toContain("연결 기기 상태를 아직 확인하지 못했어요");
    expect(body).not.toContain("Save your member key");
    expect(body).not.toContain("emk_");
    expect(home?.headers.get("content-security-policy")).toContain(
      "script-src",
    );
    const publicId = store.publicIdForMember(member!.id);
    expect(publicId).toStartWith("em_");
    expect(publicId).not.toBe(member!.id);
    expect(body).toContain(publicId!);
    const profile = await api.handle(
      new Request("https://api.example.test/v1/members", {
        headers: { cookie: `__Host-elanous_member_session=${session}` },
      }),
    );
    expect(
      ((await profile?.json()) as { member: { publicId: string } }).member
        .publicId,
    ).toBe(publicId!);
  } finally {
    store.close();
  }
});

test("KCB signup keeps its dedicated same-origin success redirect", async () => {
  const store = createMemberStore({ path: ":memory:" });
  try {
    store.provisionEventCode({
      code: "KCB1114",
      maxUses: Number.MAX_SAFE_INTEGER,
      startsAt: "2026-11-12T15:00:00Z",
      endsAt: "2026-11-15T15:00:00Z",
    });
    const options = {
      store,
      google: {
        redirectUri:
          "https://api.example.test/v1/members/oauth/google/callback",
        complete: async () => ({
          identity: {
            sub: "kcb-member",
            email: "kcb@example.test",
            emailVerified: true,
            name: "KCB Member",
          },
          intent: {
            consents: { privacy: "v1", terms: "v1" },
            eventCode: "kcb_1114",
          },
        }),
      } as never,
      successRedirectUri: "https://app.example.test/member",
      webOrigin: "https://app.example.test",
      kcbSuccessRedirectUri: "https://app.example.test/app/signup/complete/",
      now: () => Date.parse("2026-11-14T01:00:00.000Z"),
    };
    const api = createMembersApi(options);
    const callback = await api.handle(
      new Request(
        "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
        {
          headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
        },
      ),
    );
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get("location")).toBe(
      options.kcbSuccessRedirectUri,
    );
    expect(store.memberForGoogleSub("kcb-member")?.eventCode).toBe("KCB1114");
    expect(() =>
      createMembersApi({
        ...options,
        kcbSuccessRedirectUri:
          "https://other.example.test/app/signup/complete/",
      }),
    ).toThrow("KCB success redirect must share the member web origin");
  } finally {
    store.close();
  }
});

test("callback destination follows this request, not an existing member event code", async () => {
  const at = "2026-11-14T01:00:00.000Z";
  const identity = {
    sub: "returning-member",
    email: "returning@example.test",
    emailVerified: true,
    name: "Returning Member",
  } as const;
  const consents = { privacy: "v1", terms: "v1" };
  for (const scenario of [
    {
      previousCode: "KCB1114",
      requestedCode: undefined,
      expected: "https://app.example.test/member",
    },
    {
      previousCode: undefined,
      requestedCode: "KCB_1114",
      expected: "https://app.example.test/app/signup/complete/",
    },
  ]) {
    const store = createMemberStore({ path: ":memory:" });
    try {
      store.provisionEventCode({
        code: "KCB1114",
        maxUses: Number.MAX_SAFE_INTEGER,
        startsAt: "2026-11-12T15:00:00Z",
        endsAt: "2026-11-15T15:00:00Z",
      });
      store.register(
        identity,
        {
          consents,
          ...(scenario.previousCode
            ? { eventCode: scenario.previousCode }
            : {}),
        },
        at,
      );
      const api = createMembersApi({
        store,
        google: {
          redirectUri:
            "https://api.example.test/v1/members/oauth/google/callback",
          complete: async () => ({
            identity,
            intent: {
              consents,
              ...(scenario.requestedCode
                ? { eventCode: scenario.requestedCode }
                : {}),
            },
          }),
        } as never,
        successRedirectUri: "https://app.example.test/member",
        webOrigin: "https://app.example.test",
        kcbSuccessRedirectUri: "https://app.example.test/app/signup/complete/",
        now: () => Date.parse(at),
      });
      const callback = await api.handle(
        new Request(
          "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
          {
            headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
          },
        ),
      );
      expect(callback?.status).toBe(303);
      expect(callback?.headers.get("location")).toBe(scenario.expected);
      expect(store.memberForGoogleSub(identity.sub)?.eventCode).toBe("KCB1114");
    } finally {
      store.close();
    }
  }
});

test("a member who already has a handle still lands on the API home, not the success redirect", async () => {
  const store = createMemberStore({ path: ":memory:" });
  try {
    const identity = {
      sub: "handled-member",
      email: "handled@example.test",
      emailVerified: true,
      name: "Handled Member",
    } as const;
    store.register(
      identity,
      { consents: { privacy: "v1", terms: "v1" } },
      "2026-11-14T01:00:00.000Z",
    );
    store.claimHandle(store.memberForGoogleSub(identity.sub)!.id, "handledone");
    const api = createMembersApi({
      store,
      google: {
        redirectUri:
          "https://api.example.test/v1/members/oauth/google/callback",
        complete: async () => ({
          identity,
          intent: { consents: { privacy: "v1", terms: "v1" } },
        }),
      } as never,
      successRedirectUri: "https://app.example.test/member",
      webOrigin: "https://app.example.test",
    });
    const callback = await api.handle(
      new Request(
        "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
        {
          headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
        },
      ),
    );
    expect(callback?.status).toBe(303);
    expect(callback?.headers.get("location")).toBe(
      "https://api.example.test/v1/members/home",
    );
  } finally {
    store.close();
  }
});

test("MEMBER-HOME-AFTER-SIGNUP-DEADEND: home right after signup shows real devices, no 404 connect link, and a web-chat path", async () => {
  const store = createMemberStore({ path: ":memory:" });
  try {
    const api = createMembersApi({
      store,
      google: {
        redirectUri:
          "https://api.example.test/v1/members/oauth/google/callback",
        complete: async () => ({
          identity: {
            sub: "deadend-member",
            email: "deadend@example.test",
            emailVerified: true,
            name: "Deadend Member",
          },
          intent: { consents: { privacy: "v1", terms: "v1" } },
        }),
      } as never,
      successRedirectUri: "https://app.example.test/member",
      webOrigin: "https://app.example.test",
    });
    const callback = await api.handle(
      new Request(
        "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
        {
          headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
        },
      ),
    );
    const session = /__Host-elanous_member_session=([^;]+)/.exec(
      callback?.headers.get("set-cookie") ?? "",
    )?.[1];
    const read = async () =>
      (await api.handle(
        new Request("https://api.example.test/v1/members/home", {
          headers: { cookie: `__Host-elanous_member_session=${session}` },
        }),
      ))!.text();
    const fresh = await read();
    const hrefs = [...fresh.matchAll(/href="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    // Before a device is connected: the site root, the in-page connect guide and (no handle yet) the website's handle
    // step. Never the 404 /app/connect, never /app/chat (401 for a member cookie), never the web /app («곧 열립니다»).
    expect(hrefs).toEqual([
      "https://app.example.test/",
      "#connect-guide",
      "https://app.example.test/v1/members/handle",
    ]);
    expect(fresh).toContain(
      'data-member-handle-step href="https://app.example.test/v1/members/handle">핸들 정하기</a>',
    );
    expect(fresh).toContain(
      'class="primary" href="#connect-guide">기기 연결하는 법</a>',
    );
    expect(fresh).toContain('id="connect-guide"');
    expect(fresh).toContain("eln member connect");
    expect(fresh).not.toContain("data-member-webchat-entry");
    // No member key yet: an honest «연결 전», not «확인하지 못했어요».
    expect(fresh).toContain("연결 전");
    expect(fresh).not.toContain("확인하지 못했어요");
    expect(fresh).toContain("내 주소 두 가지");
    const member = store.memberForGoogleSub("deadend-member")!;
    // A revoked key is not a connected device: no «연결했어요» for it.
    const revoked = store.createMemberKey(member.id, "old-laptop");
    expect(store.revokeMemberKey(member.id, revoked.id)).toBe(true);
    const afterRevoke = await read();
    expect(afterRevoke).not.toContain("old-laptop");
    expect(afterRevoke).not.toContain("이 기기를 엘라누스에 연결했어요");
    expect(afterRevoke).toContain("기기 연결하는 법</a>");
    store.createMemberKey(member.id, "my-laptop");
    const linked = await read();
    expect(linked).toContain("my-laptop");
    expect(linked).not.toContain("old-laptop");
    expect(linked).toContain("이 기기를 엘라누스에 연결했어요");
    expect(linked).not.toContain("연결 전");
    expect(linked).not.toContain("/app/chat");
    // Connected but the handle is still unset (MEMBER-HOME-WEBCHAT-LINK-WRONG, OP 88490 안 A): the public
    // slot address is <app>--<handle>, so there is no working chat host yet — no web-chat link; the handle
    // step is the next action (the hero primary plus the address card's quiet link).
    expect(
      [...linked.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual([
      "https://app.example.test/",
      "https://app.example.test/v1/members/handle",
      "https://app.example.test/v1/members/handle",
    ]);
    expect(linked).not.toContain("data-member-webchat-entry");
    expect(linked).not.toContain("data-member-start-terminal");
    expect(linked).toContain(
      '<a class="primary" data-member-handle-step href="https://app.example.test/v1/members/handle">핸들 정하기</a>',
    );
    store.claimHandle(member.id, "deadend");
    store.ensureNativeAppSlotForMember(member.id);
    const handled = await read();
    expect(handled).toContain("deadend.elanous.app");
    // MEMBER-HOME-WEBCHAT-SERVING-GATE (OP #91609 ①): with no serving signal the home never links
    // to the slot host (a 404 in production); the member sees their own address with «곧 열림» instead.
    expect(handled).not.toContain("data-member-webchat-entry");
    expect(handled).toContain(
      "data-member-webchat-soon>내 주소: deadend.elanous.app (곧 열림)</p>",
    );
    expect(handled).not.toContain("/app/chat");
    expect(
      [...handled.matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(["https://app.example.test/"]);
    expect(handled).not.toContain("data-member-start-terminal");
    expect(handled).not.toContain("data-member-handle-step");
  } finally {
    store.close();
  }
});

test("MEMBER-HOME-WEBCHAT-LINK-WRONG: a handle-less member is never linked to the fallback slot host (the 404 dead end of MK #88484)", async () => {
  const store = createMemberStore({ path: ":memory:" });
  try {
    const api = createMembersApi({
      store,
      google: {
        redirectUri:
          "https://api.example.test/v1/members/oauth/google/callback",
        complete: async () => ({
          identity: {
            sub: "kcb-test-1112",
            email: "kcb@example.test",
            emailVerified: true,
            name: "KCB 시험 회원",
          },
          intent: { consents: { privacy: "v1", terms: "v1" } },
        }),
      } as never,
      successRedirectUri: "https://app.example.test/member",
      webOrigin: "https://app.example.test",
      // The production shape of MK #88484: with no public user slug the slot address falls back to a
      // legacy <app>--kcb-test-1112.elanous.app host the relay does not serve — a 404 dead end.
      publicAppUrl: (slot) =>
        `https://${slot.appSlug}--kcb-test-1112.elanous.app/`,
    });
    const callback = await api.handle(
      new Request(
        "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
        {
          headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
        },
      ),
    );
    const session = /__Host-elanous_member_session=([^;]+)/.exec(
      callback?.headers.get("set-cookie") ?? "",
    )?.[1];
    const member = store.memberForGoogleSub("kcb-test-1112")!;
    store.createMemberKey(member.id, "kcb-laptop");
    const slot = store.ensureNativeAppSlotForMember(member.id);
    expect(slot).not.toBeNull();
    const home = await (await api.handle(
      new Request("https://api.example.test/v1/members/home", {
        headers: { cookie: `__Host-elanous_member_session=${session}` },
      }),
    ))!.text();
    // 안 A: handle 미정 → no «웹채팅 시작» link at all; the handle step is the next action.
    expect(home).not.toContain("data-member-webchat-entry");
    expect(home).not.toContain("--kcb-test-1112.elanous.app");
    // 핸들 없음 → «내 주소 … (곧 열림)» 줄도 0 (OP #92257 리터럴 1)
    expect(home).not.toContain("data-member-webchat-soon");
    expect(home).toContain(
      '<a class="primary" data-member-handle-step href="https://app.example.test/v1/members/handle">핸들 정하기</a>',
    );
    expect(home).not.toContain("data-member-start-terminal");
  } finally {
    store.close();
  }
});

test("MEMBER-HOME-WEBCHAT-SERVING-GATE: a serving signal opts the home back into the slot-host link", async () => {
  const store = createMemberStore({ path: ":memory:" });
  try {
    const api = createMembersApi({
      store,
      google: {
        redirectUri:
          "https://api.example.test/v1/members/oauth/google/callback",
        complete: async () => ({
          identity: {
            sub: "serving-gate-member",
            email: "gate@example.test",
            emailVerified: true,
            name: "Serving Gate Member",
          },
          intent: { consents: { privacy: "v1", terms: "v1" } },
        }),
      } as never,
      successRedirectUri: "https://app.example.test/member",
      webOrigin: "https://app.example.test",
      // The relay pin ledger lands here later; until then only an explicit signal restores the link.
      webChatServing: () => true,
    });
    const callback = await api.handle(
      new Request(
        "https://api.example.test/v1/members/oauth/google/callback?code=fake&state=valid-state",
        {
          headers: { cookie: "__Host-elanous_member_oauth_state=fake-state" },
        },
      ),
    );
    const session = /__Host-elanous_member_session=([^;]+)/.exec(
      callback?.headers.get("set-cookie") ?? "",
    )?.[1];
    const member = store.memberForGoogleSub("serving-gate-member")!;
    store.createMemberKey(member.id, "gate-laptop");
    store.claimHandle(member.id, "gate");
    store.ensureNativeAppSlotForMember(member.id);
    const home = await (await api.handle(
      new Request("https://api.example.test/v1/members/home", {
        headers: { cookie: `__Host-elanous_member_session=${session}` },
      }),
    ))!.text();
    expect(home).toContain(
      'data-member-webchat-entry href="https://api.example.test/v1/members/webchat-handoff">웹채팅 시작</a>',
    );
    // 렌더된 HTML 의 링크(href) 에 앱 슬롯 호스트(<app>--<handle>) 0 — 공개 앱 서빙 면이지 웹채팅 진입이
    // 아니다 (출처: OP #106824 · MK #106820 — 앱 슬롯 링크 클릭 401). «내 주소 두 가지» 안내 문구의
    // `--gate.elanous.app` 는 링크가 아닌 지문이므로 href 스코프로 잰다.
    expect(
      [...home.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).join(" "),
    ).not.toContain("--gate.elanous.app");
    expect(home).not.toContain("data-member-webchat-soon");
  } finally {
    store.close();
  }
});
