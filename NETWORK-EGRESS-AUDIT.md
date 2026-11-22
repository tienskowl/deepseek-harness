# DSH network egress audit — fork review

Scope: DSH **host process** network calls. This document records findings from source inspection, not a claim of exhaustive dynamic verification.

## Confirmed guard coverage

| Transport | Entry point | Enforcement |
|---|---|---|
| Node global `fetch` and compatible Undici | `packages/util/http-proxy/src/install.ts` | Guarded global Undici dispatcher |
| DSH-created explicit Undici dispatchers | `createRouteDispatcher` | Guarded outgoing dispatch |
| Node `http.request`, `http.get` | `packages/util/http-proxy/src/node-http-audit.ts` | Guarded classic HTTP methods |
| Node `https.request`, `https.get` | Same | Guarded classic HTTPS methods |
| Blocked-domain config | `$DSH_HOME/network-policy.json` | Loaded at profile startup; default `deepseek.cn`, `deepseek.com` |

The Node classic HTTP guard is installed synchronously before asynchronous Undici installation. **The first invocation is still inside `runProfile()`, not a process preload**; modules imported before then can cache original network functions.

## Audited special cases

| Source | Behavior | Assessment |
|---|---|---|
| `packages/account/deepseek-auth/src/index.ts` | Official fallback API endpoint `https://api.deepseek.com` | Expected to be denied by guarded HTTP callers |
| `packages/session/session-log-deepseek` | `dsh_session_log` sent as a model-request sibling field | Disabled by this fork's default composition |
| `packages/session/session-telemetry-otel` | OTel session export | Disabled by this fork's default composition |
| `packages/client/product-analytics` | Desktop analytics producer | Disabled by this fork's default composition |
| `packages/ssh/ssh/src/stream-security.ts` | `node:tls.connect` authenticates an already connected forwarded socket | Not a new destination dial in this function |
| `packages/experimental/inspector/src/host/plugin.ts` | Imports `node:net` for an Inspector bridge | Not covered by classic HTTP; review endpoint when enabling Inspector |
| `packages/experimental/liveshare/src/owner-gateway/worker.ts` | Independent worker opens `ws` WebSocket to configurable Relay URL | Outside current process policy; separately enforce or disable LiveShare |
| `apps/desktop/src/account-backend.ts` | Desktop WebSocket client to derived host origin | Requires specific host policy verification; not covered by classic HTTP assumption |
| `packages/util/http-proxy/README.md` | Documents custom dispatcher, Node HTTP telemetry, child workers and third-party transport exceptions | Existing proxy egress tests cannot alone prove denylist enforcement |

The repository already provides `scripts/verify-no-bare-dispatcher.ts` and individual `egress.spec.ts` tests for several transport consumers. Preserve these upstream guards and extend their network-policy cases rather than invent a duplicate transport architecture.

## Known escapes and unverified paths

1. Direct `node:http2`, `node:net`, `node:tls` and native networking; static searches did not establish a complete inventory of dynamically imported or third-party transports.
2. HTTP CONNECT or a URL embedded within another service's payload: the guard observes the **actual immediate HTTP origin**, not arbitrary tunnels' ultimate targets.
3. A module caching the original `request` function before the startup guard installs it.
4. `fetch` with an explicit custom Undici Dispatcher that bypasses the guarded global dispatcher.
5. Worker threads, spawned processes, independent MCP servers and Bash commands.
6. IP literals, DoH, DNS aliases and application-managed resolver overrides do not reveal the intended blocked hostname to a hostname-only policy.

## Acceptance / regression gates

- Run `pnpm exec vitest run packages/util/http-proxy/tests/network-policy.spec.ts packages/util/http-proxy/tests/node-http-audit.spec.ts packages/util/http-proxy/tests/install.spec.ts`.
- Run `pnpm run typecheck` and project-required build gates.
- Verify blocked domain calls are absent from an **independent** egress capture (not just `dsh: network audit denied` logs).
- Verify non-blocked Provider requests and localhost transport still work.
- Repeat for startup, account sign-in, model list, compaction, shutdown, Desktop if used, and plugin-enabled scenarios.
- On upstream merges, compare new raw transport / WebSocket / custom dispatcher call sites against this inventory.

**No proof of full host-process or cross-process egress containment is provided by this PR.** For that assurance, apply an OS/network-namespace enforced deny/allow boundary outside DSH and test it independently.
