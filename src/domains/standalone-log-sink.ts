// ── 독립 스크립트용 logs.db sink 등록 헬퍼 ────────────────────────────────────
//
// 크론 사이클·미션 러너 등 별도 스폰 프로세스는 데몬(nexus)의 StoreSink 를 상속하지 않는다.
// 등록 안 하면 그 프로세스의 `debug.log(...)` 가 파일 트레일에만 남고 logs.db 에 안 닿아
// `elanous logs` 로 조회 불가(= 관측 안 한 것). 이 헬퍼가 run-mission 이 쓰던 3줄 블록을 캡슐화해
// 모든 독립 크론 스크립트가 한 줄로 데몬과 같은 instanceName 의 logs.db 싱크를 붙이게 한다.
//
// fail-open: 등록 무엇이 실패해도 스크립트는 그대로 돈다(파일 트레일이 진실원).

/**
 * 독립 프로세스에서 logs.db 싱크를 등록한다. 반환된 off 는 process 'exit' 에 자동 배선된다.
 * @param surface  이 프로세스가 남기는 로그의 surface 라벨(예: 'scheduler'·'autopilot').
 * @param opts.wrapSink  logs.db 싱크를 감싼다(예: TUI 는 pid·`--name`·세션을 data 에 찍는다 — debug/tui-log-tag.ts).
 */
export async function registerStandaloneLogSink(
  surface: string,
  opts: { wrapSink?: (sink: import('../mss/logging/sink.js').LogSink) => import('../mss/logging/sink.js').LogSink } = {},
): Promise<boolean> {
  try {
    const [storeMod, dbgMod, cfgMod] = await Promise.all([
      import('../mss/logging/log-store.js'),
      import('../debug/log.js'),
      import('../user-config.js'),
    ]);
    // TUI-LOG-SESSION-TAG — 한 logs.db 를 여러 TUI(클래식·next)가 쓴다: 행마다 pid·`--name`·소유 세션을 data 에 찍는다.
    if (surface === 'tui' && !opts.wrapSink) {
      const tagMod = await import('../debug/tui-log-tag.js');
      const tag = tagMod.processTuiLogTag();
      opts = { ...opts, wrapSink: (s) => tagMod.withTuiLogTag(s, tag) };
    }
    const logsCfg = cfgMod.getUserConfig().logs;
    storeMod.setLogInstanceName(logsCfg.instanceName);
    // TUI-TYPING-LAG — TUI 는 워커 로그 폭주를 덩어리로 나눠 넣는다(키가 drain 전체를 기다리지 않게).
    const drainChunkSize = storeMod.logStoreDrainChunkForSurface(surface);
    const offStore = storeMod.registerLogStoreSink(
      (s) => dbgMod.debug.registerSink(opts.wrapSink ? opts.wrapSink(s) : s),
      surface,
      logsCfg.retention,
      drainChunkSize !== undefined ? { drainChunkSize } : {},
    );
    if (!offStore) return false;
    process.on('exit', offStore);
    // LF7 — 격리 인스턴스면 레지스트리 등록 → `elanous logs --instance <name>`/`--all`/`instances`
    // 로 발견 가능(2026-07-16 discord-test 러너 실측). ⚠️ prod 루트는 스킵 — 크론 등 prod
    // 프로세스가 prod 데몬 레지스트리 항목을 덮지 않게(오염 방지·stateDir 키 upsert).
    //
    // ⚠️ 판정 축 정정(2026-07-27) — 종전엔 `ELANOUS_STATE_DIR` 의 **존재 여부**로 게이팅했다.
    //   3층(트리 파생 test) 스위치가 켜진 뒤 워크트리 self-dev 자식은 **env 없이 리졸버로**
    //   test 우주를 정하므로, `.elanous-test/logs/logs.db` 에 로그를 쓰면서도 이 가드에 걸려
    //   등록을 통째로 건너뛰었다 — 격리는 됐는데 **발견이 안 되는** 상태(운영에서
    //   `logs --all --include-test` 로도 자식이 안 보임 = 제1원칙 위반). 그래서 게이트를
    //   "env 가 있냐" 가 아니라 **"리졸브된 루트가 운영 루트와 다르냐"** 로 바꾼다.
    //   경로(logsDbPath)·이름(resolveLogInstanceName)·등록이 이제 같은 축을 본다.
    await (async () => {
      try {
        const [{ effectiveInstanceRoot, prodInstanceRoot }, pathMod] = await Promise.all([
          import('../instance/resolve.js'),
          import('node:path'),
        ]);
        const stateDir = effectiveInstanceRoot();
        const prodRoot = prodInstanceRoot();   // 운영 루트는 리졸버 SSOT(복제 금지)
        // ⚠️ kind 는 이름과 **같은 축**으로 판정한다 — 운영 루트가 아니면 test.
        //   종전엔 `basename === '.elanous-test'` 로만 봐서 `~/.elanous/telegram-test` 같은
        //   관례 밖 격리 루트가 이름은 `test:telegram-test` 인데 kind 는 'prod' 로 등록됐다.
        //   명시 kind 는 resolveInstanceKind 의 이름 유추를 이기므로, 그 항목이 연합
        //   기본 조회에 운영으로 섞이고 `--include-test` 의미도 갈렸다(리뷰 지적).
        //   repoPath 부착만 `<repo>/.elanous-test` 관례에 한정한다(그때만 의미가 있다).
        const isRepoTest = pathMod.basename(stateDir) === '.elanous-test';
        if (stateDir === prodRoot) {
          dbgMod.debug.log('instance.identity', 'log-sink-register-skipped', {
            stateDir, why: '운영 루트 — prod 데몬 레지스트리 항목 오염 방지',
          });
          return;
        }
        const { getElanousConfigDir } = await import('../elanous-config-dir.js');
        const name = storeMod.resolveLogInstanceName();
        const regMod = await import('../mss/logging/instance-registry.js');
        const { resolveHostId } = await import('../platform/host-id.js');
        const { hostname } = await import('node:os');
        regMod.registerLogInstance({
          hostId: resolveHostId(),
          hostname: hostname(),
          name,
          stateDir,
          kind: 'test',                 // 운영 루트는 위에서 이미 걸러졌다
          configDir: getElanousConfigDir(),
          ...(isRepoTest ? { repoPath: pathMod.dirname(stateDir) } : {}),
          pid: process.pid,
          startedAt: new Date().toISOString(),
        });
        dbgMod.debug.log('instance.identity', 'log-sink-registered', {
          name, stateDir, kind: 'test', repoScoped: isRepoTest, surface,
          why: '비-운영 루트 — 연합 조회에서 발견 가능해야 한다',
        });
      } catch { /* fail-open */ }
    })();
    return true;
  } catch {
    /* fail-open — 파일 트레일이 진실원 */
    return false;
  }
}
