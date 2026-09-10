# ACP feature gaps in pi-acp

Status of the adapter against the Agent Client Protocol, focused on what matters for Zed.

- Adapter: pi-acp 0.0.33, `@agentclientprotocol/sdk` 0.26.0, advertises protocol v1
- Client: Zed (external agents / Agent Panel)
- Investigated: 2026-09-09

## What already works

For context, the adapter currently supports: `initialize`, `session/new`, `session/load`
(with full history replay), `session/list` + `session/delete` (unstable session picker),
`session/prompt` with streaming (`agent_message_chunk`, `agent_thought_chunk`),
`session/cancel`, tool calls with status lifecycle, structured diffs for `edit`/`write`
(via before/after file snapshots), live bash output rendered as a display-only terminal in
Zed (vendor `_meta.terminal_info/output/exit` keys), tool call `locations` (follow mode),
slash commands (`available_commands_update`), session config options + modes (model picker,
thinking level), image prompts, prompt queueing, and `session/request_permission` for pi
extension `confirm`/`select` UI requests.

## Gap summary

| #   | Feature                                               | ACP status                      | Adapter status                            | Zed impact                                                             | Feasibility              |
| --- | ----------------------------------------------------- | ------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------ |
| 1   | `usage_update` + `PromptResponse.usage`               | Stabilized (2026-06)            | Implemented                               | Context-window/cost indicator in Zed                                   | Implemented              |
| 2   | Tool-call permission gating                           | Stable                          | Missing for core tools                    | High — pi always runs in "YOLO mode"                                   | Hard (needs pi support)  |
| 3   | `promptCapabilities.embeddedContext`                  | Stable                          | Opt-in via env (by design)                | Enable `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` for @-mentions            | Not a gap                |
| 4   | Client FS (`fs/read_text_file`, `fs/write_text_file`) | Stable                          | Supported via companion `pi-acp-fs`       | Unsaved buffers visible to overridden file tools                       | Implemented              |
| 5   | `plan` / `plan_update` updates                        | Stable                          | Supported via companion `todo`            | Plan panel for successful `todo` results                               | Implemented              |
| 6   | `session/resume`                                      | Stabilized (2026-04)            | Implemented                               | Fast reconnects without replay (per spec)                              | Implemented              |
| 7   | `session/close`                                       | Stabilized (2026-04)            | Implemented                               | Explicit per-session resource cleanup                                  | Implemented              |
| 8   | `session/fork`                                        | Unstable                        | Implemented (file copy)                   | Checkpoint/branch flows in clients that support fork                   | Implemented              |
| 9   | Client terminals (`terminal/*`)                       | Stable                          | Supported via companion `pi-acp-terminal` | Real client terminals with stop control; `_meta` emulation as fallback | Implemented              |
| 10  | StopReason fidelity                                   | Stable                          | Implemented                               | Failed turns surface as errors; `length` → `max_tokens`                | Implemented              |
| 11  | MCP servers                                           | Stable (+ unstable `acp` proxy) | Accepted, ignored                         | Medium — Zed-configured MCP servers silently dropped                   | Hard (pi has no MCP)     |
| 12  | `additionalDirectories`                               | Stable                          | Implemented (system prompt)               | Multi-root worktrees visible to pi as extra roots                      | Implemented              |
| 13  | `session/load` replay fidelity                        | Stable                          | Implemented                               | Titles, locations, diffs, thinking, images replayed                    | Implemented              |
| 14  | Elicitation (`elicitation/create`)                    | Unstable                        | Implemented (form mode)                   | pi `input`/`editor` UI requests render as forms                        | Implemented              |
| 15  | ACP v2 / `auth/login`                                 | Emerging                        | v1 only, terminal-login out-of-band       | Low today                                                              | Track                    |
| 16  | Tool kind/title polish                                | Stable                          | Implemented                               | Search/fetch/think icons; `name arg` titles                            | Implemented              |
| 17  | NES, providers, document sync                         | Unstable                        | Missing                                   | Low — very new, unclear Zed adoption                                   | Track                    |
| 18  | Native subagent sessions                              | Draft RFD (open)                | Tool-card fallback via extension          | Medium — child transcripts as navigable sessions                       | Blocked upstream (track) |

## Details

### 1. Token usage / context window (`usage_update`, `PromptResponse.usage`) — RESOLVED

The adapter emits throttled `usage_update` notifications during streaming
(`message_update`/`message_end`, context size from `get_state`) and a final one on
`agent_settled` from `get_session_stats`, and attaches `usage` to the `session/prompt`
response (src/acp/session.ts, src/acp/translate/usage.ts).

### 2. Permission gating for core tools

`session/request_permission` is only used for pi extension `confirm`/`select` UI events
(src/acp/session.ts:958). Pi's core tools (`bash`, `edit`, `write`, ...) execute
unconditionally in RPC mode — there is no ask-before-run flow, no "Always allow" option
in Zed, and no way to run pi in a safer mode from the Agent Panel.

This is bounded by pi: its RPC mode has no tool-approval hook. Options:

- Upstream: ask pi for a tool-approval event in RPC mode (pre-execution pause + response).
- Adapter-side partial: ship a pi extension that wraps risky tools and uses pi's
  `confirm` extension-UI request, which the adapter already translates to
  `session/request_permission`.

Related: ACP session **modes** are conventionally used for permission presets
(ask/auto/yolo — this is how Claude Code and Gemini CLI appear in Zed's mode selector).
pi-acp repurposes modes for the thinking level. That's functional, but if permission
gating ever lands, modes are the natural place for it and thinking level already has a
config option (`thought_level`), so the mode slot is double-booked.

### 3. `embeddedContext` opt-in via env — BY DESIGN

`promptCapabilities.embeddedContext` is advertised only when
`PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` (src/acp/agent.ts, initialize). With it on, Zed
sends @-mentions as embedded `resource` blocks, which `promptToPiMessage` inlines
(src/acp/translate/prompt.ts). With it off, @-mentions arrive as `resource_link` blocks
reduced to a `[Context] <uri>` hint and pi re-reads the file itself.

This stays opt-in deliberately (prompt-size control with large files); set the env var
in the Zed agent server config to enable it. No default change planned.

### 4. Client filesystem delegation

Implemented via the companion `pi-acp-fs` extension (see `extensions/README.md`).
When the client advertises filesystem capabilities, each new or restored session gets
a local IPC bridge to `fs/read_text_file` / `fs/write_text_file`. The extension overrides
`read` with read capability, `write` with write capability, and `edit` with both.
Client errors and timeouts fall back to disk; image detection and directory creation
remain local. Without the extension, or for other tools such as bash, unsaved buffers
remain invisible. Existing adapter diff snapshots still use disk and may not reflect
unsaved buffer contents.

### 5. Plan updates

Zed renders `plan` / `plan_update` entries as a live to-do panel (used heavily by Claude
Code's TodoWrite). The adapter emits ACP `plan` updates after successful companion
`todo` tool results containing `details.todos` entries with `content`, `status`, and
`priority`. Malformed entries are skipped; malformed payloads and error results do not
emit plans. Empty lists clear the plan. pi core alone has no plan/todo tool.

### 6–8. Session lifecycle: `resume`, `close`, `fork`

- **`session/resume`** (stabilized 2026-04, `sessionCapabilities.resume`): reconnect
  without history replay. Complete per spec: the agent MUST NOT replay history on
  resume, and the response MAY carry config/mode state. The adapter reuses an active pi
  process or restores the stored session file, returns config options/models/modes,
  re-announces the stored title via `session_info_update`, and advertises slash
  commands. SDK 0.26 has no `replayFrom`; when ACP v2 folds `session/load` into
  `session/resume` (see #15), that is the piece to add. Possible polish, not a gap:
  emit `usage_update` right after resume so Zed's context indicator is populated before
  the next turn.
- **`session/close`** (stabilized 2026-04, `sessionCapabilities.close`): free a session's
  resources explicitly. Implemented: best-effort cancellation followed by process
  disposal. Idempotent; session files and mappings remain available for load/resume.
- **`session/fork`** (unstable, `sessionCapabilities.fork`): branch a conversation.
  Implemented adapter-side (`unstable_forkSession`): `forkPiSessionFile` copies the
  source session JSONL next to it with a fresh header `id`, the requested `cwd`, and
  `parentSession` pointing at the source, preserving the full entry tree. A new pi
  process is spawned on the copy via the normal restore path; the source process (if
  running) is untouched, so forking works mid-turn. The response carries the new
  `sessionId`, config options/modes, and `_meta.piAcp.forkedFrom`; the source title is
  re-announced via `session_info_update`. The SDK method is still `unstable_`; revisit
  when it stabilizes. `additionalDirectories` on the request is honored (see #12).

### 9. Real client terminals — RESOLVED (companion extension)

Implemented via the companion `pi-acp-terminal` extension (see `extensions/README.md`),
mirroring the FS delegation design. The per-session IPC bridge (`src/acp/client-bridge.ts`,
generalized from the former `FsBridge`) gains `terminalRun` / `terminalKill` operations.
When the client advertises `clientCapabilities.terminal`, the adapter sets
`PI_ACP_TERMINAL=1` and the extension overrides `bash` with `createBashToolDefinition`
operations that run the command through `terminal/create`, poll `terminal/output`
(~150 ms, delta-forwarded to pi), `terminal/wait_for_exit`, and `terminal/kill` on
abort/timeout, then `terminal/release`. Once the bridge reports the client terminal id,
the session swaps the tool card content to the standard `{type:"terminal"}` block for
that id and stops emitting the vendor `_meta.terminal_*` keys, which remain the fallback
without the extension. Commands are never re-run: local fallback happens only when the
client never created the terminal.

### 10. StopReason fidelity — RESOLVED

The adapter tracks the last assistant `message_end` `stopReason`/`errorMessage` and
`auto_retry_end` failures per turn (src/acp/session.ts). On `agent_settled`:
`length` → `max_tokens`, `aborted` or a requested cancel → `cancelled`, `error` or retry
exhaustion → the turn rejects with `PiTurnError`, which `prompt()` in src/acp/agent.ts
converts to a JSON-RPC internal error carrying pi's message. Subprocess failures take the
same path. Zed marks the turn as failed and offers retry instead of silently stopping.
`max_turn_requests` and `refusal` have no pi equivalent yet.

### 11. MCP servers

`session/new` accepts `mcpServers` and stores them; nothing is done with them and
`mcpCapabilities` is all-false. Zed users who configure project MCP servers get silent
drops. pi deliberately has no MCP support (extensions instead), so options are: document
the limitation prominently, or build an MCP→pi-tool bridge extension (large effort). The
SDK also has an unstable client-proxied MCP transport (`mcpCapabilities.acp`,
`mcp/connect`) which doesn't change pi's side of the problem.

### 12. `additionalDirectories` — RESOLVED (system prompt)

The adapter advertises `sessionCapabilities.additionalDirectories` and accepts the field
on `session/new`, `session/load`, `session/resume`, and `session/fork`
(`src/acp/additional-directories.ts`). Entries are validated as absolute paths, deduped,
and `cwd` itself is dropped. pi is single-root, so the roots are injected via
`pi --append-system-prompt` at spawn time as a short "additional workspace roots" note
listing the absolute paths. The list is persisted in the pi-acp session store and
reported back in `session/list` `SessionInfo.additionalDirectories`.

Per spec, each request's list is authoritative (omitting it means no roots). A running
pi cannot change its system prompt, so a warm `session/resume` whose list differs from
the active session restarts the pi process; identical lists reuse it. pi's own tools
still resolve relative paths against `cwd` only - the model is told to use absolute
paths for the extra roots.

### 13. `session/load` replay fidelity — RESOLVED

History replay (src/acp/agent.ts:loadSession) mines assistant `toolCall` blocks from
`get_messages` (`src/acp/translate/tool-args.ts`, shared with the live path):

- `tool_call` replays carry title, `kind`, `rawInput`, and `locations`.
- Successful `edit` results render as one `diff` hunk per replacement (`oldText`/`newText`
  from the arguments); `write` results render as a full-file diff with `oldText: null`.
  Errors and tools without a path fall back to text output.
- Assistant `thinking` blocks replay as `agent_thought_chunk` before the message text;
  user `image` blocks replay as image `user_message_chunk`s.
- `session_info_update` (title/updatedAt) is sent on load from the stored pi session.

Remaining limitation: historic edit diffs are reconstructed from arguments, not from
file snapshots, so they show the replaced fragments rather than surrounding context.

### 14. Elicitation (unstable) — RESOLVED

pi extension `input` / `editor` UI requests are now mapped to form-mode
`elicitation/create` (single string field; `placeholder` → description, editor
`prefill` → default) when the client advertises `clientCapabilities.elicitation.form`
at initialize (src/acp/session.ts `handleExtensionInput`). Clients without the
capability still get the old chat notice + cancel fallback. The SDK method is still
`unstable_createElicitation`; revisit when it stabilizes.

### 15. ACP v2 & protocol-driven auth

ACP v2 is being drafted: `authenticate` → `auth/login` (+ `auth/logout`),
`session/load` removed in favor of `session/resume` with `replayFrom`, restructured
initialize. The adapter is v1-only and handles auth out-of-band by relaunching with
`--terminal-login` (plus a Zed-specific `_meta["terminal-auth"]` check). No action
needed yet, but the v2 migration will touch `initialize`, auth, and session loading —
the implemented `session/resume` capability provides a foundation.

### 16. Cosmetic: tool kinds and titles — RESOLVED

`src/acp/translate/tool-presentation.ts` maps `grep`/`find`/`ls` (and `ffgrep`/`fffind`)
→ `search`, `web_search`/`fetch_content`/`source_check` → `fetch`, `todo` → `think`, in
addition to `read`/`edit`/`execute`. Titles are `name primary-arg`: cwd-relative path for
file tools, quoted pattern plus optional `in <path>` for search tools, query/URL for fetch
tools, truncated at 80 chars. Titles refresh while arguments stream. `session/load` replay
reuses the same helpers and now recovers arguments from assistant `toolCall` blocks, so
historic tool calls get real titles and `rawInput` (partially addresses #13).

### 17. Very new unstable surface (track only)

The SDK exposes unstable APIs with no clear pi mapping yet: NES (next edit
suggestions, `nes/*`), provider management (`providers/*`), and editor document-sync
notifications (`document/didOpen` etc.). Revisit once stabilized or once Zed adopts
them for external agents.

### 18. Native subagent sessions — BLOCKED UPSTREAM (track)

Today subagent output is display-only: the companion `pi-acp-subagents` extension renders
`@tintinweb/pi-subagents` runs as expandable tool cards (`src/acp/translate/subagents.ts`).
There is no parent/child session linkage, no per-child permission routing, and no
replay of live cards on `session/load`.

Upstream state (checked 2026-09-11):

- ACP draft RFD [agent-client-protocol#1992](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)
  (open, ~15 unresolved review threads). Shape: bilateral negotiation
  (`clientCapabilities.subagents: {}` ↔ `sessionCapabilities.subagents: {}`),
  `subagent_spawned` on the parent before any child output, child updates streamed under
  the child `sessionId`, one terminal `subagent_state_update` on the parent, child tree
  reconstruction on `session/load` (orphans → `disconnected`). Open questions from the
  maintainer: collapse the two notifications into a single upsert-style `subagent_update`
  (v2 pattern), drop redundant `subagentSessionId`, whether child `cancel`/`close`
  capabilities are needed, cwd/MCP/capability inheritance, and splitting the RFD from the
  schema PR. Two underspecified edge cases: client state on disconnect without a terminal
  update, and pending permission/elicitation requests on a cancelled child.
- Older draft [agent-client-protocol#855](https://github.com/agentclientprotocol/agent-client-protocol/pull/855)
  is stalled and effectively superseded; [discussion #690](https://github.com/orgs/agentclientprotocol/discussions/690)
  (`ToolKind: subagent`) has no decision.
- Reference implementations: [codex-acp#419](https://github.com/agentclientprotocol/codex-acp/pull/419)
  ([docs](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/subagent-sessions.md)) and
  [claude-agent-acp#1017](https://github.com/agentclientprotocol/claude-agent-acp/pull/1017).
  Both keep a legacy tool-call fallback when the capability is not negotiated.
- SDK: released `@agentclientprotocol/sdk` (0.26.0) strips the draft `subagents` fields.
  JetBrains AIR bridges this with `_meta.jetbrains.air.capabilities = ["nativeSubagentSessions"]`.
- Zed: `client_capabilities_for_agent` (`crates/agent_servers/src/acp.rs`) advertises no
  `subagents` capability. The `subagent_session_info` `_meta` key and
  `tool_call_for_subagent` navigation in `crates/acp_thread` serve Zed's native
  `spawn_agent` tool only, not external ACP agents. Demand tracked in
  [zed#49452](https://github.com/zed-industries/zed/discussions/49452),
  [zed#54602](https://github.com/zed-industries/zed/issues/54602),
  [zed#55809](https://github.com/zed-industries/zed/issues/55809).
- pi side: `@tintinweb/pi-subagents` exposes lifecycle events for top-level launches and
  background resumes only; workflow-owned and nested children are excluded. Per-child
  permission routing would also need child `confirm`/`select` requests surfaced.

Waiting on, in order: RFD acceptance → SDK exposing the fields → Zed sending the client
capability. Plan when unblocked: keep the tool-card fallback and add an opt-in native path
gated on `clientCapabilities.subagents` (mirroring codex-acp). Hold until the
single-vs-two-notification question is settled, as that is the part most likely to change.

## Known Zed-specific quirks (not protocol gaps)

- Queued-prompt notices are emitted as chat text plus `session_info_update._meta`
  metadata that Zed does not render (noted in src/acp/session.ts).
- `session/list` from Zed sends no `cwd`; the adapter filters by the last-seen cwd to
  emulate a project-scoped picker.
- Startup info is delivered as a delayed `agent_message_chunk` because Zed ignores
  notifications that arrive before the `session/new` response is processed.

## Suggested priority order

1. Permission gating - start upstream conversations with pi; the biggest remaining UX
   gap and it needs pi-side hooks (terminal delegation is now handled by extension).
2. Native subagent sessions - no action until ACP RFD #1992 lands and Zed advertises the
   capability; re-check quarterly.
