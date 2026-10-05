# Ultracode and dynamic workflows for Pi

Status: planned. Decisions: [docs/decisions/LOG.md](../decisions/LOG.md).

Goal: a Pi equivalent of Claude Code's `ultracode` and dynamic workflows. The model writes a JavaScript orchestration script, a sandboxed runtime runs it in the background and starts many Pi subagents, and only the final result returns to the conversation. Works in the Pi TUI and in Zed through pi-acp.

Reference: <https://code.claude.com/docs/en/workflows>, <https://code.claude.com/docs/en/model-config> (ultracode section).

## Scope

| Repo                                      | Component                                         | Change                                                                                                     |
| ----------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/packages/pi-workflows` (new) | Extension + detached supervisor + QuickJS runtime | `workflow` tool, `/workflows`, `/ultracode`, keyword trigger, saved workflows, worktree isolation          |
| `~/.pi/agent/packages/pi-subagents`       | `runner.mjs`                                      | Becomes a shared library; exports kept stable, small additions (cwd override, no-bridge mode)              |
| `~/Projects/pi-acp`                       | Adapter                                           | Long-lived workflow cards, many children per tool call, Ultracode config option, restore on `session/load` |
| `~/Projects/zed`                          | Fork patch                                        | Multiple child-session links per tool call                                                                 |

Out of scope for v1: bundled `/deep-research`, loading `.claude/workflows/`, auto-merging worktree branches, usage-limit pause/wait.

## Architecture

```
Zed ──ACP──> pi-acp ──RPC──> pi (parent session)
                               └─ pi-workflows extension
                                    │  spawn detached, attach via unix socket
                                    ▼
                         workflow supervisor (node, one per run)
                           ├─ worker_thread: QuickJS VM running the script
                           ├─ scheduler (concurrency, caps, journal, replay)
                           └─ agents: pi --mode json children via pi-subagents runSubagent()
```

- **Supervisor per run.** A detached `node supervisor.mjs <runDir>` process owns the VM and all agents. It survives `/reload`, Zed reconnects and pi restarts. The extension is only a client: it starts, attaches, relays progress and delivers results.
- **Run directory** is the source of truth, so any pi process (or a restarted supervisor) can reconstruct state.
- **Agents** reuse `runSubagent`, `childArguments`, `childEnvironment` and `childTools` from `../pi-subagents/runner.mjs`. Child tool allowlist = parent's active tools minus delegation, `ask_user` and `workflow`.

### Run directory

`<agentDir>/workflows/runs/<runId>/` (mode `0700`, files `0600`):

| File                                | Content                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.json`                          | `{runId, name, parentPiSessionId, parentSessionFile, parentToolCallId, cwd, args, model, thinking, tools, trusted, createdAt, quickjsPath, quickjsVersion}` |
| `script.js`                         | Exact script being run (editable before relaunch)                                                                                                           |
| `journal.jsonl`                     | One record per agent event: `{seq, index, key, event: "start"\|"end", status, result?, error?, agentDir, completionOrder?}`                                 |
| `events.jsonl`                      | Sequenced progress events (phase, log, agent start/end, usage) for UIs and replay into Zed                                                                  |
| `state.json`                        | `{status: running\|paused\|completed\|failed\|stopped\|interrupted, phase, counts, usage, result?, error?, delivered: bool}`                                |
| `supervisor.pid`, `supervisor.lock` | Liveness and single-owner lock (`O_EXCL` + pid check)                                                                                                       |
| `control.sock`                      | Unix socket: `attach`, `pause`, `resume`, `stop`, `stopAgent(i)`, `restartAgent(i)`                                                                         |
| `agents/<index>/`                   | pi-subagents run dir per agent (`session.jsonl`, `events.jsonl`, `output.txt`, `state.json`)                                                                |

### Lifecycle

1. Model calls `workflow({script} | {name, args} | {resume: runId})`.
2. Extension checks approval, writes the run dir, spawns the supervisor `detached: true, stdio: "ignore"` with `unref()`, waits for the socket's `ready`, and returns `{runId, scriptFile, status: "started"}` right away.
3. Supervisor runs the script. Progress goes to `events.jsonl` and to attached clients.
4. On completion the supervisor writes `state.json` with `delivered: false` and notifies clients.
5. The extension that owns the session (matching `parentPiSessionId`) delivers the report with `pi.sendMessage({customType: "workflow-result", ...}, {deliverAs: "followUp", triggerTurn: true})`, then marks `delivered: true` (atomic rename).
6. On `session_start`, the extension scans runs for this session: it reattaches to live ones and delivers undelivered terminal ones. If the supervisor died uncleanly (lock pid gone, state `running`), it marks the run `interrupted`.
7. Parent session deletion or `/workflows` stop ends the run. Pi shutdown does **not** stop it.

## Script runtime

### Sandbox

- `quickjs-wasi` resolved from Pi's install: `createRequire(join(getPackageDir(), "package.json")).resolve("quickjs-wasi")`. The extension passes the path and version to the supervisor; the supervisor refuses to start on a major-version mismatch.
- The VM runs in a `worker_thread` so `interruptHandler` (stop/pause) and `memoryLimit` work while the main thread runs agents.
- No filesystem, network, timers or `import()`. Scripts containing `import(` are rejected before the run. `Date.now()`, no-arg `new Date()` and `Math.random()` throw.
- Async bridging: each host call creates a VM `newPromise()` deferred. The host resolves it and calls `executePendingJobs()`. Results cross as JSON only.
- `export const meta = {...}` is parsed with a literal-only parser (also used for `/` command discovery), then stripped before evaluation. The body runs as an async function so top-level `await`/`return` work.

### API (Claude Code compatible + extras)

| Global                               | Semantics                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`               | Start one subagent. Resolves to the final text, the parsed JSON when `schema` is set, or `null` when stopped or failed unrecoverably        |
| `opts`                               | `label`, `schema`, `model`, `thinking`, `tools` (subset of allowed), `isolation: "worktree"`, `timeout`                                     |
| `parallel(fns)`                      | Runs thunks concurrently and resolves to all results                                                                                        |
| `pipeline(items, fn)`                | `fn(item, i)` per item with concurrency limits. Keeps `null`s. Max 4,096 items                                                              |
| `phase(title)`                       | Groups following agents. Should match `meta.phases` if declared                                                                             |
| `log(msg)`                           | Progress message above phases                                                                                                               |
| `args`                               | Invocation input, `undefined` if none                                                                                                       |
| `retry(fn, n)`                       | Extra: rerun `fn` until a non-null result or `n` attempts                                                                                   |
| `until(fn, {maxRounds, noProgress})` | Extra: loop `fn(round, prev)` until it returns `{done: true}`, `maxRounds` is hit, or `noProgress` rounds return an unchanged `progressKey` |
| `budget()`                           | Extra: `{agentsStarted, agentsLeft, tokens}` for scripts that size themselves                                                               |

Structured output: the child is told to end with a single fenced JSON block. It is validated with TypeBox's JSON-schema checker and retried up to `MAX_STRUCTURED_OUTPUT_RETRIES` (default 5) in the same child session by appending a correction prompt. Before the agent starts, self-contradictory schemas (a `required` key excluded by `additionalProperties: false`) are rejected.

### Limits

| Limit                             | Default                              | Config                                  |
| --------------------------------- | ------------------------------------ | --------------------------------------- |
| Concurrent agents per run         | `min(16, cpus)`                      | `maxConcurrentAgents` (1-256)           |
| Concurrent agents across all runs | 32                                   | `maxGlobalAgents`                       |
| Items per `parallel`/`pipeline`   | 4,096                                | fixed                                   |
| Agents per run                    | 1,000                                | fixed                                   |
| Size guideline sent to the model  | `medium` (<10)                       | `small`/`medium`/`large`/`unrestricted` |
| Large-workflow warning            | >25 agents or >1.5M projected tokens | Off while ultracode is on               |

Config file: `<agentDir>/pi-workflows.json` with an optional project override in `.pi/pi-workflows.json` (trusted projects only).

### Journal and replay

- Agents get an `index` in the order the VM calls `agent()`. `key = sha256(canonical JSON of {prompt, opts minus label})`.
- Relaunch (`{resume: runId}`) replays in start order. While `index` and `key` match a completed record, the saved result is returned. The first mismatch, failure or unfinished record switches the run to live mode: that agent and every later one runs again.
- **Determinism caveat:** with `parallel`/`pipeline`, later `agent()` call order depends on completion order. The journal records `completionOrder`, and during replay cached promises resolve in that original order (one `executePendingJobs()` per resolution). This keeps start order identical up to the divergence point.
- Stopping a single agent counts as a failure, which matches Claude Code. Stopping the whole run does not.
- Same-session constraint from Claude Code is relaxed: any session whose `parentPiSessionId` matches (including after restart) can relaunch.

## Worktree isolation

`agent(prompt, {isolation: "worktree"})`:

1. Once per run: base = `git stash create` (or `HEAD` when clean), recorded in `run.json`. Untracked, non-ignored files (`git ls-files --others --exclude-standard`) are copied into each worktree.
2. `git worktree add -b wf/<runId>/<index> <runDir>/worktrees/<index> <base>`.
3. Agent runs with `cwd` = worktree. ACP fs delegation is disabled for it (no editor buffers). Terminal delegation is already disabled for children.
4. After the agent ends: commit all changes on the branch (`wf: <label>`), `git worktree remove`.
5. Result: `{result, branch, base, diffStat}`. Branches are kept; `/workflows` → run → "Delete branches" removes them.
6. Merging is left to the script (a later agent) or the parent model.

Non-git cwd: `isolation: "worktree"` fails that agent with a clear error.

## Pi extension (`pi-workflows`)

- **Tool `workflow`**: `{script?: string, scriptFile?: string, name?: string, args?: unknown, resume?: string}`. Returns immediately. Details hold `{runId, runDir, scriptFile, workflowRun: descriptor}` for pi-acp restore.
- **Approval**: the first launch per session asks via `ctx.ui.select` with Run / View script / Deny. Consent is stored with `pi.appendEntry("pi-workflows-consent")`. Skipped when ultracode is on.
- **Delivery**: custom `workflow-result` message with the report (capped at 48 KiB, full result in `state.json`) plus run stats.
- **`/workflows`**: list runs for this session (status, phase, agents, tokens, elapsed). Actions: open progress, pause/resume, stop, stop/restart agent, save, relaunch, delete branches. TUI uses `ctx.ui.custom`; ACP uses `select` chains.
- **Saved workflows**: `.pi/workflows/*.js` (nearest ancestor up to repo root, trusted projects only) and `<agentDir>/workflows/*.js`. Project overrides personal. Registered as `/<meta.name>`, with the remainder passed as `args`. Saving refuses symlinked targets.
- **Ultracode**:
  - `/ultracode [on|off]`: session state via `pi.appendEntry("pi-ultracode")`, restored from the branch on `session_start`. Default from config `ultracode: true|false`. Does **not** change the thinking level.
  - Keyword: `input` handler matches `\bultracode\b` in human input only (`event.source` not `extension`). It enables workflow guidance for that prompt only and strips a leading `ultracode:`.
  - `before_agent_start`: when ultracode is on, or the keyword was used, add a guideline section with the API reference, size guideline, patterns (fan-out + adversarial verify, multi-angle planning, fix-until-pass) and "plan a workflow for every substantive task; several in a row is fine". When off, a short note says workflows are available on request.
  - Ultracode on means no approval prompt and no large-workflow warning.
- **Status for pi-acp**: `ctx.ui.setStatus("pi-acp:ultracode", "on"|"off")` on change and on `session_start`.

### Progress bridge to pi-acp

The extension relays supervisor events with `ctx.ui.setStatus` (using the last session context, so it also works between turns):

- `pi-acp:workflow` records (new, version 1): `{version:1, type:"register"|"progress"|"status", runId, parentToolCallId, name, phases:[{title, done, running, failed, total}], usage, status}`.
- Per agent: existing `pi-acp:subagent-session` version-2 `register`/`event`/`status` records from `runSubagent`'s `onBridge`, with `parentToolCallId` = the workflow tool call ID. On reattach, the extension replays what was missed from each agent's `events.jsonl` starting at the last sequence pi-acp acknowledged (pi-acp dedupes by `seq`).

## pi-acp changes

1. **Workflow cards outlive the tool call.** `session.ts` keeps `workflowToolCalls: Map<toolCallId, runId>`, separate from `subagentToolCalls`. On `tool_execution_end` for `workflow`, emit `status: in_progress` instead of `completed` while the run is live. `pi-acp:workflow` `progress` → `tool_call_update` content (phase table). `status` → final status and entry removal.
2. **Many children per tool call.** `subagent-sessions.ts`: `register` accepts children whose `parentToolCallId` is in `workflowToolCalls`. `link()` returns all children of a tool call. Emitted `_meta` keeps `subagent_session_info` (first/latest child, for unpatched Zed) and adds `subagent_sessions_info: SubagentSessionInfo[]`.
3. **Restore on `session/load`.** `restoreHistory` also scans `workflow` tool results (`details.workflowRun`) and `pi-workflow-run` custom entries, reads the run dir's `state.json` and `agents/*` and rebuilds cards and links. Live runs keep updating once the extension reattaches.
4. **Ultracode config option.** `buildConfigOptions` adds a `select` `ultracode` (`off`/`on`) next to Thinking, shown only after a `pi-acp:ultracode` status has been seen. `setSessionConfigOption` runs `/ultracode on|off` through the RPC `prompt` command (verify that extension commands run without a model turn, M0).
5. `isWorkflowTool(name)` in `translate/subagents.ts`, titles like `Workflow audit-routes`.

## Zed patch (`~/Projects/zed`)

- `acp_thread.rs`: `SUBAGENT_SESSIONS_INFO_META_KEY = "subagent_sessions_info"` → `Vec<SubagentSessionInfo>`. `ToolCall.subagent_sessions: Vec<SubagentSessionInfo>`, merged with the legacy single key (deduped by `session_id`, sticky like the current legacy handling). `is_subagent()` also checks the list. `tool_call_for_subagent` searches the list.
- `conversation_view.rs` (~917, ~1627): load and order every linked child.
- `thread_view.rs` (~3750 awaiting map, ~8602 render): render a workflow card with a header (title, status, phase text from content) and a compact list of children (label + status), each opening its child view.
- Tests next to the existing `subagent_session_info` tests (~13395, ~14545).
- Keep the patch as one rebasable commit on top of `main`.

## Milestones

| #   | Deliverable             | Exit criteria                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Spikes                  | (a) quickjs-wasi async host functions in a worker, with interrupt and memory limit; (b) detached supervisor survives pi exit and is reattached by a new pi; (c) Zed applies late `tool_call_update` to a completed card and keeps it `in_progress`; (d) `input.source` for pi-acp prompts counts as human; (e) RPC can run `/ultracode on` without a turn; (f) `setStatus` while idle reaches pi-acp |
| M1  | Runtime core (no Pi UI) | Supervisor + VM + API + limits + journal/replay + structured output, driven by a CLI harness with the fake-pi child from pi-subagents tests. Replay determinism test with shuffled completion times                                                                                                                                                                                                  |
| M2  | Pi extension            | `workflow` tool, approval, background delivery, reattach on `session_start`, `/workflows`, saved workflows, `/ultracode`, keyword, guidance. TUI usable end to end                                                                                                                                                                                                                                   |
| M3  | Worktree isolation      | Snapshot base incl. uncommitted + untracked, branch per agent, cleanup action, non-git error                                                                                                                                                                                                                                                                                                         |
| M4  | pi-acp                  | Long-lived workflow cards, multi-child registration and `_meta` list, restore on load, Ultracode config option. Unit tests for translation and restore                                                                                                                                                                                                                                               |
| M5  | Zed patch               | Multi-link rendering and loading, tests. Unpatched Zed still shows one link                                                                                                                                                                                                                                                                                                                          |
| M6  | Polish                  | Extras tuning, prompt-cache staggering (start first agent, hold siblings until its first token, cap 5 s), cost display, docs                                                                                                                                                                                                                                                                         |

## Testing

- pi-workflows: `node --test`. Fake pi children (reuse `pi-subagents/test/fake-pi.mjs`) for scheduler, limits, replay, stop/pause, schema retries, supervisor crash → `interrupted`, reattach and delivery exactly once. One real-Pi integration test with the offline provider fixture.
- pi-acp: `npm run test` for `pi-acp:workflow` translation, multi-child registration, card status after `tool_execution_end`, restore from a recorded session + run dir.
- Zed: `cargo test -p acp_thread -p agent_ui` for the new meta key.

## Risks and open questions

- **quickjs-wasi is Pi's internal dependency.** A Pi upgrade can change or remove it. Mitigation: version check plus a clear error; fallback is adding it as a direct dependency.
- **Detached processes**: orphans if the parent session is deleted, and machine sleep or reboot. Supervisors exit after finishing and delivering, or after 24 h with no attached client once terminal. `/workflows` lists stale runs for cleanup.
- **Concurrent edits**: non-worktree agents, the parent model and the user share the tree while a run is in the background. Guidance tells scripts to use worktrees for any agent that writes.
- **Delivery when idle in Zed**: `triggerTurn` outside a prompt starts a turn pi-acp did not request. Verify pi-acp streams it (it may need an "unsolicited turn" path).
- **Cost visibility**: per-agent usage comes from runner `usage`. Global token caps beyond the agent caps are not planned.
- **Zed fork maintenance**: the patch must be rebased on upstream changes to `acp_thread`.
