/** MEMBER-JOURNEY-FRICTIONLESS S3 (0.3.32 P0): 회원 가입 직후 «내 주소» 핸들 확인 화면.
 * Pure renderer — rebuilt per response from public metadata only; no store, clock or
 * network reads here. The confirm/save flow rides the S2 API
 * (GET /v1/members/handle/check · PUT /v1/members/handle) and never re-implements its
 * rules: the suggestion is the server's (slugFromName), taken-ness is the API's answer.
 * S4(홈 B)·S5(첫 질문 전달)는 별도 지시서 범위 밖이다. */

export interface MemberHandlePageInput {
  /** Google display name — the recommendation source («OO로 미리 채웠어요»). */
  readonly name: string;
  /** Server-computed first recommendation: slugFromName(name, email local part). */
  readonly suggestedHandle: string;
  /** Canonical member home (/v1/members/home) — the save success destination. */
  readonly homeUrl: string;
  /** Per-response CSP nonce from the route owner. */
  readonly nonce: string;
}

/** The check flow's whole client state: a generation counter (only the newest request's
 * answer lands), the asked handle, and the latest answer's shape. 'checking' is
 * transient; the rest mirror the API's statuses plus 'unavailable' for a failed lookup. */
export interface HandleCheckView {
  readonly generation: number;
  readonly handle: string;
  readonly status:
    | "checking"
    | "ok"
    | "taken"
    | "reserved"
    | "invalid"
    | "unavailable";
  readonly message: string;
  readonly alternatives: readonly string[];
}

/** Keep free of outer-scope references: this source embeds into the page script
 * (toString) — one definition, executed in tests and in the browser (inviteCodeFrom pattern). */
export function beginHandleCheck(
  previous: HandleCheckView | null,
  handle: string,
): HandleCheckView {
  return {
    generation: (previous?.generation ?? 0) + 1,
    handle,
    status: "checking",
    message: "확인하고 있어요.",
    alternatives: [],
  };
}

/** Only the newest request's answer lands; a stale answer changes nothing. A failed or
 * malformed lookup answers 'unavailable' (retryable), never a wrong status. */
export function completeHandleCheck(
  current: HandleCheckView,
  generation: number,
  payload: unknown,
): HandleCheckView {
  if (generation !== current.generation) return current;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return {
      ...current,
      status: "unavailable",
      message: "지금은 확인하지 못했어요. 잠시 뒤 다시 확인해 주세요.",
      alternatives: [],
    };
  const value = payload as Record<string, unknown>;
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.filter((item): item is string => typeof item === "string")
    : [];
  if (value.status === "ok")
    return {
      ...current,
      status: "ok",
      message: "✓ 쓸 수 있는 주소예요",
      alternatives: [],
    };
  if (value.status === "taken")
    return {
      ...current,
      status: "taken",
      message:
        alternatives.length > 0
          ? "이미 쓰이는 주소예요. 아래에서 골라 보세요."
          : "이미 쓰이는 주소예요.",
      alternatives,
    };
  if (value.status === "reserved")
    return {
      ...current,
      status: "reserved",
      message: "쓸 수 없는 주소예요. 다른 주소를 적어 주세요.",
      alternatives: [],
    };
  if (value.status === "invalid")
    return {
      ...current,
      status: "invalid",
      message: "영문 소문자로 시작하고 3~20자여야 해요.",
      alternatives,
    };
  return {
    ...current,
    status: "unavailable",
    message: "지금은 확인하지 못했어요. 잠시 뒤 다시 확인해 주세요.",
    alternatives: [],
  };
}

export type HandleSaveOutcome =
  | { readonly kind: "home" }
  | { readonly kind: "signin" }
  | { readonly kind: "recheck" }
  | { readonly kind: "unavailable" };

/** PUT /v1/members/handle 판정: 저장 성공(200)은 정본 홈으로, 만료된 로그인(401)은 다시
 * 로그인으로, 충돌(400 invalid · 403 reserved · 409 taken/locked)은 확인 절차로 되돌리고,
 * 나머지는 화면에 남는다. */
export function resolveHandleSaveOutcome(status: number): HandleSaveOutcome {
  if (status === 200) return { kind: "home" };
  if (status === 401) return { kind: "signin" };
  if (status === 400 || status === 403 || status === 409)
    return { kind: "recheck" };
  return { kind: "unavailable" };
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

/** Standalone HTML for the signed-in handle confirmation step. The caller sets the
 * session and CSP headers; the script is the check/save flow above. */
export function renderMemberHandlePage(input: MemberHandlePageInput): string {
  const nonce = html(input.nonce);
  const suggested = html(input.suggestedHandle);
  const name = html(input.name);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>내 주소 확인 · Elanous</title>
<style nonce="${nonce}">:root{color-scheme:light;--bg:#F4F7FD;--surface:#FFF;--fg:#1D2751;--muted:#55608A;--line:#D9E1F2;--accent:#3556B8;--cta:#F5A524;--ok:#168969;--warn:#B4541F}*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI",Roboto,"Noto Sans KR",sans-serif;word-break:keep-all;overflow-wrap:break-word}.wrap{max-width:880px;margin:0 auto;padding:0 24px}header.top{display:flex;justify-content:space-between;align-items:center;padding:16px 0;font-size:14px;color:var(--muted)}.brand{color:var(--fg);text-decoration:none;font-weight:600;font-size:16px}main.split{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;margin:32px auto 64px;align-items:start}.label{font-size:13px;letter-spacing:.12em;color:var(--accent);margin-bottom:16px}h2{font-weight:400;font-size:clamp(22px,2.8vw,28px);line-height:1.35;letter-spacing:-.02em}.steps{list-style:none;display:grid;gap:10px;margin-top:18px;counter-reset:s}.steps li{counter-increment:s;display:flex;gap:12px;align-items:center;font-size:15px;color:var(--muted)}.steps li::before{content:counter(s);width:28px;height:28px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:13px;background:var(--surface);flex:none}.steps li.done{color:var(--fg)}.steps li.done::before{content:"✓";background:#DFF5E8;border-color:#DFF5E8;color:var(--ok)}.steps li.now{color:var(--fg);font-weight:600}.steps li.now::before{background:var(--fg);border-color:var(--fg);color:#fff}.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px 22px;box-shadow:0 1px 2px rgba(29,39,81,.04)}.card h1{font-size:24px;font-weight:600;letter-spacing:-.02em}.muted{color:var(--muted);font-size:14px;margin-top:4px}.handle-field{display:flex;align-items:center;border:1px solid var(--accent);border-radius:12px;background:var(--surface);padding:0 14px;margin-top:12px;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}.handle-field input{flex:1;min-width:0;width:100%;border:0;outline:0;background:transparent;font:600 17px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);padding:14px 0}.handle-field span{font:15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap}#handle-status{font-size:13.5px;margin-top:10px;min-height:22px;color:var(--ok)}#handle-status.bad{color:var(--warn)}.alts{list-style:none;display:grid;gap:8px;margin-top:10px}.alts button{all:unset;cursor:pointer;display:block;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:11px 14px;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);box-sizing:border-box}.alts button:hover{border-color:var(--accent)}.rule{font-size:12.5px;color:var(--muted);margin-top:10px}.cta{display:inline-flex;align-items:center;justify-content:center;width:100%;margin-top:20px;background:var(--cta);border:1px solid var(--cta);color:#1B1B1B;font-family:inherit;font-size:16px;font-weight:600;padding:13px 30px;border-radius:999px;cursor:pointer}.cta:disabled{opacity:.6}@media (max-width:720px){main.split{margin:24px auto 48px}.card{padding:20px 18px}.wrap{padding:0 18px}}@media (max-width:380px){.wrap{padding:0 16px}.handle-field span{font-size:13px}.cta{padding:12px 22px;font-size:15px}}</style></head>
<body><div class="wrap"><header class="top"><a class="brand" href="/">elanous</a></header>
<main class="split"><div><p class="label">시작하기</p><h2>두 걸음이면 끝나요.</h2>
<ol class="steps"><li class="done">Google 계정 연결</li><li class="now">내 주소 확인</li><li>첫 질문</li></ol></div>
<div class="card"><h1>내 주소</h1>
<p class="muted">Google 이름(${name})으로 미리 채웠어요. 맞으면 확인만 누르세요.</p>
<form id="handle-form"><div class="handle-field"><input id="handle-input" value="${suggested}" aria-label="핸들" autocomplete="off" spellcheck="false" maxlength="20"><span>.elanous.app</span></div>
<p id="handle-status" role="status" aria-live="polite"></p>
<ul class="alts" id="handle-alternatives"></ul>
<p class="rule">바로 고쳐 쓸 수 있어요 · 이미 쓰이는 주소면 비슷한 주소를 추천해요 · 영문 소문자로 시작 3~20자 · 정한 뒤엔 바꿀 수 없어요</p>
<button type="submit" id="handle-save" class="cta">확인</button></form></div></main></div>
<script nonce="${nonce}">(function(){
var HOME_URL = ${JSON.stringify(input.homeUrl)};
${beginHandleCheck.toString()}
${completeHandleCheck.toString()}
${resolveHandleSaveOutcome.toString()}
var active = true;
var view = null;
var timer;
var field = document.getElementById('handle-input');
var statusLine = document.getElementById('handle-status');
var altList = document.getElementById('handle-alternatives');
var saveButton = document.getElementById('handle-save');
function renderView(){
  statusLine.textContent = view ? view.message : '';
  statusLine.classList.toggle('bad', !(view && (view.status === 'ok' || view.status === 'checking')));
  altList.textContent = '';
  if (view) {
    for (var index = 0; index < view.alternatives.length; index++) {
      var alternative = view.alternatives[index];
      var item = document.createElement('li');
      var pick = document.createElement('button');
      pick.type = 'button';
      pick.textContent = alternative + '.elanous.app';
      pick.addEventListener('click', function(chosen){ return function(){
        if (!active) return;
        field.value = chosen;
        void check();
      };}(alternative));
      item.appendChild(pick);
      altList.appendChild(item);
    }
  }
}
async function check(){
  var handle = field.value.trim().toLowerCase();
  if (!handle) { view = null; renderView(); return; }
  view = beginHandleCheck(view, handle);
  renderView();
  var generation = view.generation;
  var payload = null;
  try {
    var response = await fetch('/v1/members/handle/check?handle=' + encodeURIComponent(handle), { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) {
      try { payload = await response.json(); } catch (error) { payload = null; }
    }
  } catch (error) { payload = null; }
  if (!active) return;
  view = completeHandleCheck(view, generation, payload);
  renderView();
}
async function save(){
  if (!active) return;
  var handle = field.value.trim().toLowerCase();
  if (!handle) { statusLine.textContent = '주소를 적어 주세요.'; return; }
  saveButton.disabled = true;
  statusLine.textContent = '저장하고 있어요.';
  var status = 0;
  try {
    var response = await fetch('/v1/members/handle', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: handle }) });
    status = response.status;
  } catch (error) { status = 0; }
  if (!active) return;
  var outcome = resolveHandleSaveOutcome(status);
  if (outcome.kind === 'home') { window.location.assign(HOME_URL); return; }
  saveButton.disabled = false;
  if (outcome.kind === 'signin') { statusLine.textContent = '로그인이 만료됐어요. 다시 로그인해 주세요.'; return; }
  if (outcome.kind === 'unavailable') { statusLine.textContent = '지금은 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.'; return; }
  void check();
}
document.getElementById('handle-form').addEventListener('submit', function(event){
  event.preventDefault();
  if (active && !saveButton.disabled) void save();
});
field.addEventListener('input', function(){
  if (!active) return;
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(function(){ void check(); }, 250);
});
window.addEventListener('pagehide', function(){ active = false; if (timer) window.clearTimeout(timer); });
window.addEventListener('pageshow', function(){ active = true; });
void check();
})();</script></body></html>`;
}