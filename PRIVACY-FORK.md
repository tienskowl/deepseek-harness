# Privacy defaults for this fork

This branch changes defaults only; it does **not** claim to block every network connection.

## Changed defaults

- `packages/bundle/base/cordis.patch.yml`: `session-log-deepseek.enabled: false` prevents the official DeepSeek adapter from appending the `dsh_session_log` session-history field to model requests.
- `packages/bundle/base/cordis.patch.yml`: `session-telemetry-otel.mode: DISABLED` prevents the default Session OTel exporter from being initialized.
- `packages/bundle/web-app/cordis.patch.yml`: `product-analytics.enabled: false` disables Desktop product analytics collection by default (regular Web was already excluded).

Normal provider inference, explicitly invoked Web tools, MCP services, and Bash networking remain available.

## Boundaries

- These are defaults, **not immutable bans**: later profile/home/CLI overlay configuration and supported live settings can override them. For strict enforcement, add a boot-time policy and network egress firewall.
- The OTel service can remain mounted without an active exporter. Disabling session telemetry does not, by itself, disable the separate DeepSeek session-log request extension; that is why both are changed.
- The Desktop product telemetry plugin remains mounted. Disabling its analytics producer prevents normal Desktop event intake but does not prove that arbitrary plugins cannot submit telemetry.
- Other optional plugins, updates, account sign-in/refresh, model API calls, Web tools, subagents, and Bash may still connect externally.
- This branch has not yet passed a built-artifact network audit.

## Suggested acceptance checks

1. Boot CLI/Web and Desktop in a test environment without inherited user configuration.
2. Confirm a normal DeepSeek inference request contains no `dsh_session_log` member.
3. Confirm no Session or product OTLP requests are emitted during start, normal interaction, compaction and exit.
4. Verify explicit Web/MCP/Bash requests still work.
5. Repeat with an egress policy and log all outbound domains; reject unexpected destinations.
6. Run the repository's tests and build workflow before merging.


## Built-in network audit / hostname deny rules

Edit `$DSH_HOME/network-policy.json` (usually `~/.dsh/network-policy.json`):

```json
{
  "blockedDomains": ["deepseek.cn", "deepseek.com"],
  "auditDenied": true
}
```

- The file is optional; the default is to block both suffixes.
- Changing `blockedDomains` changes the full list (including `[]` to disable domain blocking); restart DSH to apply it.
- Exact hostname and every DNS subdomain are matched, case-insensitively. A sibling such as `notdeepseek.com` is **not** matched.
- Invalid JSON or malformed domains fail startup rather than silently permitting unexpected requests.
- A denial is logged on stderr as `dsh: network audit denied <hostname>` (hostname only; never path, token, headers, request body). Set `auditDenied: false` to suppress logging without disabling blocking.

### Enforcement scope and limitations

This is an **in-process Undici dispatch** safeguard. It covers Node global `fetch`, compatible Undici transports, and the DSH-created dispatchers through the proxy package. It also works when the user has configured no proxy. It does **not** intercept arbitrary `node:http`/`node:https` clients, custom SDK transports, OS DNS/TCP, independent subprocesses (Bash, MCP, child Agents), or workers; the caller may also override the dispatcher. For complete domain denial across the whole process tree, use a separate egress firewall/transparent sandbox. Requests to a blocked official model API will fail, by design.

The policy is an early startup check for CLI profiles rather than a Cordis plugin or late runtime setting. The CLI plugin-management and other non-profile modes are not yet included.

Run `pnpm exec vitest run packages/util/http-proxy/tests/network-policy.spec.ts` and the usual repository CI checks. A live-network audit is still required.
