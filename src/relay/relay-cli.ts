import type { Command } from "commander";
import { join } from "node:path";
import { getElanousConfigDir } from "../elanous-config-dir.js";
import {
  createRelayAutoAppRegistrar,
  ensureRelayAutoRegistrationFile,
  createRelayPublicPolicyReloader,
  loadRelayPublicPolicySnapshot,
} from "./public-app-auto-registration.js";

export interface RelayPublicOptions {
  publicDomain?: string;
  publicServerId?: string;
  publicUserId?: string;
  publicDispatchConfig?: string;
  memberRequired?: boolean;
}

export interface RelayCommandOptions {
  readonly appKillSwitchDatabasePath?: string;
  readonly write?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
}

async function withAppKillSwitch<T>(
  options: RelayCommandOptions,
  run: (
    control: Awaited<
      ReturnType<typeof import("./app-kill-switch.js").createAppKillSwitch>
    >,
    operatorId: string,
  ) => T | Promise<T>,
): Promise<void> {
  let control:
    | Awaited<
        ReturnType<typeof import("./app-kill-switch.js").createAppKillSwitch>
      >
    | undefined;
  try {
    const { createAppKillSwitch } = await import("./app-kill-switch.js");
    const databasePath =
      options.appKillSwitchDatabasePath ??
      join(getElanousConfigDir(), "relay", "app-kill-switch.sqlite");
    control = createAppKillSwitch(databasePath, {
      authorizeReactivation: ({ actor }) => {
        const uid = process.getuid?.();
        if (actor.kind !== "operator" || uid === undefined) return false;
        // The module opens only a current-user-owned database under a private directory.
        return actor.id === `uid-${uid}`;
      },
    });
    const operatorId =
      process.getuid === undefined
        ? "unavailable-local-operator"
        : `uid-${process.getuid()}`;
    await run(control, operatorId);
  } catch (error) {
    (options.error ?? ((text: string) => process.stderr.write(text)))(
      `relay app-kill-switch: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    (
      options.setExitCode ??
      ((code: number) => {
        process.exitCode = code;
      })
    )(1);
  } finally {
    control?.close();
  }
}

export function validateRelayPublicOptions(opts: RelayPublicOptions): void {
  if (
    opts.publicDomain &&
    !["elanous.app", "elanous.ai"].includes(opts.publicDomain)
  )
    throw new Error("public domain must be elanous.app or elanous.ai");
  if (opts.publicDispatchConfig) {
    if (
      !opts.publicDomain ||
      opts.publicServerId ||
      opts.publicUserId ||
      !opts.memberRequired
    ) {
      throw new Error(
        "--public-dispatch-config requires --public-domain and --member-required without single-user pins",
      );
    }
    return;
  }
  if (
    !!opts.publicDomain !== (!!opts.publicServerId && !!opts.publicUserId) ||
    !!opts.publicServerId !== !!opts.publicUserId
  ) {
    throw new Error(
      "--public-domain, --public-server-id, and --public-user-id must be supplied together",
    );
  }
}

/** `elanous relay serve` — 릴레이 서버(R2 · 내부 문서 `RFC-mobile-relay-without-tailscale-2026-09-30` A5).
 *  index.ts 원문을 잘라 보는 시험(첫 `.command('serve')` = mcp)을 흔들지 않게 등록을 여기 둔다. */
export function registerRelayCommand(
  program: Command,
  options: RelayCommandOptions = {},
): void {
  const relayCmd = program
    .command("relay")
    .description("Encrypted WebSocket relay");
  relayCmd
    .command("serve")
    .description(
      "Serve private relay connections and optionally the invited Nexus app public domain",
    )
    .requiredOption(
      "--trusted-host-keys <file>",
      "JSON object of X25519-derived serverId to Ed25519 public key (base64url)",
    )
    .option("--port <port>", "Listening port", "8765")
    .option(
      "--public-domain <domain>",
      "Enable the public app proxy for elanous.app or elanous.ai (TLS must terminate at the local edge proxy)",
    )
    .option(
      "--public-server-id <id>",
      "Pinned Nexus host serverId that receives its configured public user app hosts",
    )
    .option(
      "--public-user-id <id>",
      "User label bound to this single Nexus host",
    )
    .option(
      "--public-dispatch-config <file>",
      "Owner-only JSON routes from public user label to pinned Nexus host and member",
    )
    .option(
      "--member-required",
      "Require a current relay.connect member token for every WebSocket connection (default false)",
    )
    .option(
      "--member-nexus-url <url>",
      "HTTPS Nexus origin for relay token introspection",
    )
    .option(
      "--host-owner-members <file>",
      "JSON serverId-to-memberId pins for member-required mode",
    )
    .option(
      "--member-service-hosts <file>",
      "Owner-only JSON {serverId:true} member-service binding keys (owner-less service role; RES #106180)",
    )
    .option(
      "--traffic-cap-config <file>",
      "Owner-only JSON with byte limits or measure-only mode",
    )
    .option(
      "--public-listing-config <file>",
      "Owner-only JSON opt-in list of searchable public app IDs (default empty)",
    )
    .option(
      "--public-read-config <file>",
      "Owner-only JSON apps:[{user,app}] allowed anonymous GET/HEAD (default private)",
    )
    .option(
      "--visitor-write-config <file>",
      "Owner-only expiring per-app POST path/rate policy (default denied; public-read opt-in required)",
    )
    .option(
      "--public-handle-claims <file>",
      "Owner-only JSON {[handle]:ownerMemberId} mapping auto-pin handles to claiming members (default: no auto pins)",
    )
    .option(
      "--custom-domain-config <file>",
      "Owner-only JSON routes for custom hosts with verified DNS ownership and TLS certificates",
    )
    .action(
      async (opts: {
        trustedHostKeys: string;
        port: string;
        publicDomain?: string;
        publicServerId?: string;
        publicUserId?: string;
        publicDispatchConfig?: string;
        memberRequired?: boolean;
        memberNexusUrl?: string;
        hostOwnerMembers?: string;
        memberServiceHosts?: string;
        trafficCapConfig?: string;
        publicListingConfig?: string;
        publicReadConfig?: string;
        visitorWriteConfig?: string;
        publicHandleClaims?: string;
        customDomainConfig?: string;
      }) => {
        const port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("invalid relay port");
        const {
          loadTrustedHostKeys,
          resolvePublicAppUserId,
          startRelayServer,
        } = await import("./relay-server.js");
        const publicUserId =
          opts.publicDomain && !opts.publicDispatchConfig
            ? resolvePublicAppUserId(opts.publicUserId)
            : opts.publicUserId;
        const resolvedOpts = {
          ...opts,
          ...(publicUserId ? { publicUserId } : {}),
        };
        validateRelayPublicOptions(resolvedOpts);
        if (
          opts.memberRequired &&
          (!opts.memberNexusUrl || !opts.hostOwnerMembers)
        ) {
          throw new Error(
            "--member-required requires --member-nexus-url and --host-owner-members",
          );
        }
        if (!opts.memberRequired && opts.trafficCapConfig)
          throw new Error("--traffic-cap-config requires --member-required");
        if (opts.publicListingConfig && !opts.publicDomain)
          throw new Error("--public-listing-config requires --public-domain");
        if (
          opts.visitorWriteConfig &&
          (!opts.publicDomain || !opts.memberRequired || !opts.publicReadConfig)
        ) {
          throw new Error(
            "--visitor-write-config requires public domain, member-required and public-read config",
          );
        }
        const memberOptions = opts.memberRequired
          ? await (async () => {
              const { createNexusRelayMemberVerifier, loadRelayHostOwners } =
                await import("./relay-member-verifier.js");
              const { loadRelayTrafficCap } = await import("./relay-server.js");
              // (출처: #39104) 회원 서버 역할 서비스 토큰 — env 또는 0600 권한
              // 파일로 회전한다(없으면 서비스 자격 게이트 자체가 꺼진다).
              const { resolveMemberServiceToken } = await import(
                "./member-service-token.js",
              );
              const memberServiceToken = resolveMemberServiceToken();
              return {
                memberRequired: true,
                hostOwnerMemberIds: loadRelayHostOwners(opts.hostOwnerMembers!),
                validateMemberToken: createNexusRelayMemberVerifier(
                  opts.memberNexusUrl!,
                ),
                ...(memberServiceToken
                  ? { memberServiceToken } // (출처: #39104) «핀 읽기»만 넓힌다
                  : {}),
                ...(opts.trafficCapConfig
                  ? { trafficCap: loadRelayTrafficCap(opts.trafficCapConfig) }
                  : {}),
              };
            })()
          : {};
        const { loadRelayPublicListing, loadRelayCustomDomainRoutes } =
          await import("./relay-server.js");
        const publicListedApps = opts.publicListingConfig
          ? loadRelayPublicListing(opts.publicListingConfig)
          : undefined;
        const publicReadableApps = opts.publicReadConfig
          ? (await import("./public-app-read.js")).loadPublicAppReadConfig(
              opts.publicReadConfig,
            )
          : undefined;
        const visitorPolicy = opts.visitorWriteConfig
          ? await import("./public-app-visitor-write.js")
          : undefined;
        const publicVisitorWritePolicies = opts.visitorWriteConfig
          ? visitorPolicy!.loadPublicAppVisitorWriteConfig(
              opts.visitorWriteConfig,
            )
          : undefined;
        const customDomainRoutes = opts.customDomainConfig
          ? loadRelayCustomDomainRoutes(opts.customDomainConfig)
          : undefined;
        const publicDispatchRoutes = opts.publicDispatchConfig
          ? (await import("./public-dispatch.js")).loadPublicDispatchRoutes(
              opts.publicDispatchConfig,
            )
          : undefined;
        const { createAppKillSwitch } = await import("./app-kill-switch.js");
        const appKillSwitch = opts.publicDomain
          ? createAppKillSwitch(
              options.appKillSwitchDatabasePath ??
                join(getElanousConfigDir(), "relay", "app-kill-switch.sqlite"),
            )
          : undefined;
        const { createRelayTrafficLedger } =
          await import("./relay-traffic-ledger.js");
        let trafficStore:
          ReturnType<typeof createRelayTrafficLedger> | undefined;
        let publicVisitorWriteLedger:
          | import("./public-app-visitor-write.js").VisitorWriteLedger
          | undefined;
        let relay: ReturnType<typeof startRelayServer>;
        const policyFiles =
          opts.publicDispatchConfig &&
          opts.publicReadConfig &&
          opts.hostOwnerMembers &&
          opts.memberRequired
            ? {
                trustedHostKeys: opts.trustedHostKeys,
                hostOwnerMembers: opts.hostOwnerMembers,
                publicDispatch: opts.publicDispatchConfig,
                publicRead: opts.publicReadConfig,
                ...(opts.visitorWriteConfig
                  ? { visitorWrite: opts.visitorWriteConfig }
                  : {}),
                ...(opts.publicHandleClaims
                  ? { publicHandleClaims: opts.publicHandleClaims }
                  : {}),
                // (RES #106180) PAAR:894-913 파서가 {64hex:true} 집합을 로드하고
                // initialPolicy 스프레드(:364)가 options.memberServiceServerIds
                // 로 기동 결속을 전달한다(reload·registrar 는 policyFiles 재사용).
                ...(opts.memberServiceHosts
                  ? { memberServiceHosts: opts.memberServiceHosts }
                  : {}),
                autoRegistrations: join(
                  getElanousConfigDir(),
                  "relay",
                  "auto-apps.json",
                ),
              }
            : undefined;
        if (policyFiles)
          ensureRelayAutoRegistrationFile(policyFiles.autoRegistrations);
        const initialPolicy = policyFiles
          ? loadRelayPublicPolicySnapshot(
              policyFiles,
              opts.publicDomain as "elanous.app" | "elanous.ai",
            )
          : undefined;
        let reloader:
          ReturnType<typeof createRelayPublicPolicyReloader> | undefined;
        let registrar:
          ReturnType<typeof createRelayAutoAppRegistrar> | undefined;
        try {
          trafficStore = opts.trafficCapConfig
            ? createRelayTrafficLedger()
            : undefined;
          publicVisitorWriteLedger = visitorPolicy
            ? visitorPolicy.createVisitorWriteLedger(
                join(getElanousConfigDir(), "relay", "visitor-write.sqlite"),
                getElanousConfigDir(),
              )
            : undefined;
          relay = startRelayServer({
            port,
            hostname: "127.0.0.1",
            trustedHostKeys: loadTrustedHostKeys(opts.trustedHostKeys),
            ...(opts.publicDomain
              ? {
                  publicDomain: opts.publicDomain as
                    "elanous.app" | "elanous.ai",
                }
              : {}),
            ...(opts.publicServerId
              ? { publicServerId: opts.publicServerId }
              : {}),
            ...(publicUserId ? { publicUserId } : {}),
            ...(publicDispatchRoutes ? { publicDispatchRoutes } : {}),
            ...(appKillSwitch ? { appKillSwitch } : {}),
            ...(publicListedApps ? { publicListedApps } : {}),
            ...(publicReadableApps ? { publicReadableApps } : {}),
            ...(publicVisitorWritePolicies
              ? { publicVisitorWritePolicies, publicVisitorWriteLedger }
              : {}),
            ...(customDomainRoutes ? { customDomainRoutes } : {}),
            ...(trafficStore ? { trafficStore } : {}),
            ...memberOptions,
            ...(initialPolicy ?? {}),
            ...(policyFiles
              ? {
                  autoAppRegistration: {
                    register: (
                      serverId: string,
                      ownerId: string,
                      input: import("./public-app-auto-registration.js").AutoPublicAppRegistration,
                    ) => {
                      if (!registrar)
                        throw new Error("relay app registrar unavailable");
                      registrar.register(serverId, ownerId, input);
                    },
                    unregister: (
                      serverId: string,
                      ownerId: string,
                      input: Pick<
                        import("./public-app-auto-registration.js").AutoPublicAppRegistration,
                        "user" | "app" | "deploymentId" | "grantId"
                      >,
                    ) => {
                      if (!registrar)
                        throw new Error("relay app registrar unavailable");
                      registrar.unregister(serverId, ownerId, input);
                    },
                    pinHandle: (
                      serverId: string,
                      ownerId: string,
                      input: { user: string; memberId: string },
                    ) => {
                      if (!registrar)
                        throw new Error("relay app registrar unavailable");
                      registrar.pinHandle(serverId, ownerId, input);
                    },
                    queryHandlePin: (
                      serverId: string,
                      ownerId: string,
                      input: { user: string; memberId: string },
                    ) => {
                      if (!registrar)
                        throw new Error("relay app registrar unavailable");
                      return registrar.queryHandlePin(serverId, ownerId, input);
                    },
                    queryHandleClaims: (serverId: string, ownerId: string) => {
                      if (!registrar)
                        throw new Error("relay app registrar unavailable");
                      return registrar.queryHandleClaims(serverId, ownerId);
                    },
                    // (출처: #39104) 회원 서버 서비스 자격 «핀 읽기» 위임 — 연결
                    // 소유자가 아닌 회원의 살아 있는 핀도 불리언으로 답한다.
                    queryHandlePinByMember: (
                      input: { user: string; memberId: string },
                    ) => {
                      if (!registrar)
                        throw new Error("relay app registrar unavailable");
                      return registrar.queryHandlePinByMember(input);
                    },
                  },
                }
              : {}),
          });
          if (policyFiles)
            reloader = createRelayPublicPolicyReloader(
              initialPolicy!,
              () =>
                loadRelayPublicPolicySnapshot(
                  policyFiles,
                  opts.publicDomain as "elanous.app" | "elanous.ai",
                ),
              (candidate) => relay.reloadPublicPolicySnapshot(candidate),
            );
          if (policyFiles)
            registrar = createRelayAutoAppRegistrar({
              file: policyFiles.autoRegistrations,
              domain: opts.publicDomain as "elanous.app" | "elanous.ai",
              staticPolicy: () => {
                const {
                  autoRegistrations: _autoRegistrations,
                  ...staticFiles
                } = policyFiles;
                return loadRelayPublicPolicySnapshot(
                  staticFiles,
                  opts.publicDomain as "elanous.app" | "elanous.ai",
                );
              },
              apply: (candidate) => reloader!.apply(candidate),
            });
        } catch (error) {
          trafficStore?.close();
          appKillSwitch?.close();
          publicVisitorWriteLedger?.close();
          throw error;
        }
        let policyTimer: ReturnType<typeof setInterval> | undefined;
        if (policyFiles) {
          let refused = false;
          policyTimer = setInterval(() => {
            try {
              registrar?.sweepExpired();
              reloader!.refresh();
              refused = false;
            } catch {
              if (!refused)
                console.error(
                  "relay policy reload refused; previous validated policy retained",
                );
              refused = true;
            }
          }, 1_000);
          policyTimer.unref?.();
        }
        console.log(
          `relay listening on 127.0.0.1:${relay.port}${opts.publicDomain ? " (public TLS edge required)" : ""}`,
        );
        process.once("SIGINT", () => {
          if (policyTimer) clearInterval(policyTimer);
          relay.stop();
        });
        process.once("SIGTERM", () => {
          if (policyTimer) clearInterval(policyTimer);
          relay.stop();
        });
      },
    );

  const killSwitch = relayCmd
    .command("app-kill-switch")
    .description("Stop or reactivate one tenant app and record the action");
  killSwitch
    .command("down")
    .description(
      "Persist one tenant app stop decision from an abuse or cost incident",
    )
    .requiredOption("--user-id <id>", "Tenant/user key")
    .requiredOption("--app-id <slug>", "App slug")
    .requiredOption("--incident <type>", "abuse-report or cost-spike")
    .requiredOption("--reason <text>", "Audit reason")
    .requiredOption(
      "--requested-by <id>",
      "Incident reporter or guard identity for audit",
    )
    .action(
      async (input: {
        userId: string;
        appId: string;
        incident: "abuse-report" | "cost-spike";
        reason: string;
        requestedBy: string;
      }) => {
        await withAppKillSwitch(options, (control) => {
          const event = control.applyIncident(input);
          (options.write ?? ((text: string) => process.stdout.write(text)))(
            `app kill switch state recorded: down · user=${event.userId} · app=${event.appId} · incident=${event.incident}\n`,
          );
        });
      },
    );
  killSwitch
    .command("up")
    .description("Reactivate one stopped user app as an operator")
    .requiredOption("--user-id <id>", "Tenant/user key")
    .requiredOption("--app-id <slug>", "App slug")
    .action(async (input: { userId: string; appId: string }) => {
      await withAppKillSwitch(options, (control, operatorId) => {
        const changed = control.reactivate({
          userId: input.userId,
          appId: input.appId,
          actor: { kind: "operator", id: operatorId },
        });
        (options.write ?? ((text: string) => process.stdout.write(text)))(
          `app kill switch state ${changed ? "reactivated" : "already up"} · user=${input.userId} · app=${input.appId}\n`,
        );
      });
    });
  killSwitch
    .command("status")
    .description("Read one tenant app kill-switch state")
    .requiredOption("--user-id <id>", "Tenant/user key")
    .requiredOption("--app-id <slug>", "App slug")
    .action(async (input: { userId: string; appId: string }) => {
      await withAppKillSwitch(options, (control) => {
        (options.write ?? ((text: string) => process.stdout.write(text)))(
          `app kill switch recorded state: ${control.isDown(input.userId, input.appId) ? "down" : "up"} · user=${input.userId} · app=${input.appId}\n`,
        );
      });
    });
  killSwitch
    .command("audit")
    .description("Read audit events for one tenant app")
    .requiredOption("--user-id <id>", "Tenant/user key")
    .requiredOption("--app-id <slug>", "App slug")
    .action(async (input: { userId: string; appId: string }) => {
      await withAppKillSwitch(options, (control) => {
        const events = control.audit(input.userId, input.appId);
        (options.write ?? ((text: string) => process.stdout.write(text)))(
          `${JSON.stringify(events)}\n`,
        );
      });
    });
}
