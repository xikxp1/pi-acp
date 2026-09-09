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

| #   | Feature                                               | ACP status                      | Adapter status                      | Zed impact                                                 | Feasibility                    |
| --- | ----------------------------------------------------- | ------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| 1   | `usage_update` + `PromptResponse.usage`               | Stabilized (2026-06)            | Missing                             | High — no context-window/cost indicator                    | Easy (adapter-only)            |
| 2   | Tool-call permission gating                           | Stable                          | Missing for core tools              | High — pi always runs in "YOLO mode"                       | Hard (needs pi support)        |
| 3   | `promptCapabilities.embeddedContext`                  | Stable                          | Off by default (env-gated)          | High — @-mentions degrade to a bare URI                    | Easy (adapter-only)            |
| 4   | Client FS (`fs/read_text_file`, `fs/write_text_file`) | Stable                          | Supported via companion `pi-acp-fs` | Unsaved buffers visible to overridden file tools           | Implemented                    |
| 5   | `plan` / `plan_update` updates                        | Stable                          | Supported via companion `todo`      | Plan panel for successful `todo` results                   | Implemented                    |
| 6   | `session/resume`                                      | Stabilized (2026-04)            | Implemented (no history replay)     | Medium — faster reconnects                                 | Medium                         |
| 7   | `session/close`                                       | Stabilized (2026-04)            | Implemented                         | Explicit per-session resource cleanup                      | Implemented                    |
| 8   | `session/fork`                                        | Unstable                        | Missing                             | Medium — no checkpoint/edit-message flows                  | Medium (pi supports branching) |
| 9   | Client terminals (`terminal/*`)                       | Stable                          | Emulated via vendor `_meta` only    | Low-medium — display works, no client-side control         | Hard (needs pi delegation)     |
| 10  | StopReason fidelity                                   | Stable                          | Implemented                         | Failed turns surface as errors; `length` → `max_tokens`    | Implemented                    |
| 11  | MCP servers                                           | Stable (+ unstable `acp` proxy) | Accepted, ignored                   | Medium — Zed-configured MCP servers silently dropped       | Hard (pi has no MCP)           |
| 12  | `additionalDirectories`                               | Stable                          | Ignored                             | Medium — multi-root worktrees not exposed                  | Easy-medium                    |
| 13  | `session/load` replay fidelity                        | Stable                          | Lossy                               | Medium — degraded history rendering                        | Medium                         |
| 14  | Elicitation (`elicitation/create`)                    | Unstable                        | Missing                             | Low-medium — pi `input`/`editor` UI requests are cancelled | Medium                         |
| 15  | ACP v2 / `auth/login`                                 | Emerging                        | v1 only, terminal-login out-of-band | Low today                                                  | Track                          |
| 16  | Tool kind/title polish                                | Stable                          | Partial                             | Low — cosmetic                                             | Easy                           |
| 17  | NES, providers, document sync                         | Unstable                        | Missing                             | Low — very new, unclear Zed adoption                       | Track                          |

## Details

### 1. Token usage / context window (`usage_update`, `PromptResponse.usage`) — highest ROI

The `usage_update` session notification (context `used`/`size` + optional cumulative
`cost`) was stabilized in June 2026, and `PromptResponse` accepts a `usage` object
(`totalTokens`, `inputTokens`, `outputTokens`, `thoughtTokens`, cached tokens). Zed
forwards `PromptResponse.usage` to its thread UI and has a context-window indicator for
ACP agents.

pi already exposes everything needed: `get_session_stats` returns tokens + cost, and
`get_state` includes message/context info. The adapter never emits either signal — the
data is only reachable via the `/session` slash command as plain text.

Suggested: after each `agent_settled` (and periodically on `message_update`), emit
`usage_update` and attach `usage` to the `session/prompt` response in
`src/acp/session.ts` / `src/acp/agent.ts:prompt()`.

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

### 3. `embeddedContext` disabled by default

`promptCapabilities.embeddedContext` is only advertised when
`PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` (src/acp/agent.ts, initialize). With it off, Zed
sends @-mentions as `resource_link` blocks, which the adapter reduces to a
`[Context] <uri>` text hint (src/acp/translate/prompt.ts) — pi then has to re-read the
file itself, and content of unsaved buffers or non-file resources is lost entirely.

The `resource` branch of `promptToPiMessage` already handles embedded text resources
well. Enabling the capability by default (keeping the env var as an opt-out) looks like
a one-line, high-value change — worth verifying prompt-size behavior with large files.

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
  without history replay. Implemented: reuses active pi processes or restores stored
  sessions, returning configuration and advertising the stored title and commands.
- **`session/close`** (stabilized 2026-04, `sessionCapabilities.close`): free a session's
  resources explicitly. Implemented: best-effort cancellation followed by process
  disposal. Idempotent; session files and mappings remain available for load/resume.
- **`session/fork`** (unstable, `sessionCapabilities.fork`): branch a conversation.
  pi's session storage is tree-based (branching/rewind exist in the pi TUI), so this is
  plausible: copy/branch the session file and spawn a new pi on it. Enables
  checkpoint-style flows in clients that support it.

### 9. Real client terminals

Zed's live terminal rendering currently works via the **vendor** `_meta.terminal_info` /
`terminal_output` / `terminal_exit` keys (src/acp/translate/bash.ts) — display-only, and
tied to Zed's non-standard extension. The standard ACP path is for the agent to call
`terminal/create` etc. on the client and embed `{type:"terminal"}` content. Like the FS
gap, actually executing through client terminals requires pi to delegate `bash`
execution. Low urgency (the emulation is good), but the `_meta` contract could break
with any Zed release; worth tracking.

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

### 12. `additionalDirectories`

`NewSessionRequest` / `LoadSessionRequest` / `SessionInfo` carry
`additionalDirectories` for multi-root workspaces (`sessionCapabilities.additionalDirectories`).
The adapter ignores the field, so in multi-worktree Zed projects pi only sees `cwd`.
Cheap partial fix: inject the extra roots into the prompt/system context; proper fix
depends on pi understanding multiple roots.

### 13. `session/load` replay fidelity

History replay (src/acp/agent.ts:loadSession) loses information vs. the live stream:

- `tool_call` replays use `rawInput: null` and bare tool names as titles (no command,
  no file path), and `kind` is inferred from name only.
- No `locations`, so follow-mode/navigation doesn't work on historic calls.
- Edit/write history has no diffs (snapshots only exist live); results render as text.
- Assistant thinking blocks and user images are not replayed.
- `session_info_update` (title/updatedAt) is not sent on load, and pi's own session
  titles never reach Zed except via the manual `/name` command.

pi's `get_messages` includes tool-call inputs on assistant messages — mining those would
restore titles, locations, and diffs for history.

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

### 16. Cosmetic: tool kinds and titles

`toToolKind` (src/acp/session.ts) only maps `read`/`write`/`edit`/`bash`; everything
else is `other`. ACP has `search`, `fetch`, `think`, `move`, `delete` kinds — mapping
pi tools like `grep`/`glob`/`ls` → `search` and web tools → `fetch` gives Zed better
icons. Tool titles for non-bash tools are the bare tool name; including the primary
argument (path, pattern) matches what other Zed agents display.

### 17. Very new unstable surface (track only)

The SDK exposes unstable APIs with no clear pi mapping yet: NES (next edit
suggestions, `nes/*`), provider management (`providers/*`), and editor document-sync
notifications (`document/didOpen` etc.). Revisit once stabilized or once Zed adopts
them for external agents.

## Known Zed-specific quirks (not protocol gaps)

- Queued-prompt notices are emitted as chat text plus `session_info_update._meta`
  metadata that Zed does not render (noted in src/acp/session.ts).
- `session/list` from Zed sends no `cwd`; the adapter filters by the last-seen cwd to
  emulate a project-scoped picker.
- Startup info is delivered as a delayed `agent_message_chunk` because Zed ignores
  notifications that arrive before the `session/new` response is processed.

## Suggested priority order

1. Emit `usage_update` + `PromptResponse.usage` (small, stable, visible in Zed).
2. Enable `embeddedContext` by default (opt-out via env).
3. `session/load` replay fidelity (titles, locations, diffs from `get_messages`).
4. Tool kind/title polish.
5. `session/fork` on top of pi branching.
6. Permission gating & terminal delegation - start upstream conversations with pi;
   these are the biggest UX gaps but need pi-side hooks.
