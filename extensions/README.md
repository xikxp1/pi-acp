# Client FS delegation extension

`pi-acp-fs.ts` routes built-in file tools through the ACP client's filesystem API, exposing unsaved Zed buffers and applying text changes through the editor. Install with:

```sh
mkdir -p ~/.pi/agent/extensions
cp /Users/xikxp1/Projects/pi-acp/extensions/pi-acp-fs.ts ~/.pi/agent/extensions/pi-acp-fs.ts
```

Restart the ACP session after installation. Re-copy after updates. The extension is inert without `PI_ACP_FS_SOCKET`, so normal TUI pi is unchanged. Avoid other extensions overriding the same tools.

The adapter creates a session-local NDJSON socket (Unix socket on POSIX, named pipe on Windows) and sets `PI_ACP_FS_SOCKET` and `PI_ACP_FS_CAPS` only for advertised client capabilities. `read` needs read capability, `write` needs write capability, and `edit` needs both. UUID-correlated requests support concurrent operations and a 30-second timeout. Client errors, timeouts, and socket failures fall back to local disk. Image detection and directory creation stay local; bash and other tools still use disk. This is not a filesystem permission boundary. A timed-out write may still complete at the client after local fallback.

# Client terminal delegation extension

`pi-acp-terminal.ts` runs the built-in `bash` tool in a real ACP client terminal (`terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`) instead of a local child process. In Zed, each command appears as a live terminal inside the tool card, using the standard ACP `{type:"terminal"}` content rather than the Zed-only `_meta.terminal_*` emulation, and the client can stop the command itself. Install with:

```sh
mkdir -p ~/.pi/agent/extensions
cp /Users/xikxp1/Projects/pi-acp/extensions/pi-acp-terminal.ts ~/.pi/agent/extensions/pi-acp-terminal.ts
```

Restart the ACP session after installation. Re-copy after updates. The extension activates only when the adapter sets `PI_ACP_TERMINAL=1` (client advertised `clientCapabilities.terminal`) together with the bridge socket in `PI_ACP_FS_SOCKET`, so normal TUI pi is unchanged. It shares the socket with `pi-acp-fs.ts`; both can be installed together. Avoid other extensions overriding `bash`.

How it works and limitations:

- The whole command string is sent as `command` with empty `args`; Zed runs it through the user's shell (`$SHELL -c`) with the session `cwd`. Only environment variables pi adds on top of the process environment (for example `PI_SESSION_ID`, `PI_MODEL`) are forwarded; the client terminal already has the user's shell environment.
- ACP has no output push, so the adapter polls `terminal/output` every ~150 ms and forwards deltas to pi, which still applies its own truncation and rendering. Output is retained by the client up to 4 MiB; if the client truncates from the front, the adapter re-anchors on the already forwarded tail.
- pi's `timeout` argument and turn cancellation are honored by sending `terminal/kill`; pi reports `Command timed out` / `Command aborted` as usual. Commands are never re-run: if the client fails to create the terminal (or the bridge is unavailable) the command runs locally instead, but any failure after the terminal was created surfaces as a tool error.
- If pi exits mid-command, the adapter kills orphaned client terminals. Terminals are released after the final output read; the client keeps rendering the finished output in the tool card.
- Exit codes come from the client; a command terminated by a signal reports a `null` exit code to pi. Zed disables pagers (`PAGER`, `GIT_PAGER`) in agent terminals.

# Session title extension

`pi-acp-session-title.ts` names the session from the first line of the first user prompt (truncated to 80 chars; slash commands are skipped, and an existing name is never overwritten). The pi-acp adapter forwards the name to ACP clients as the thread title after each turn, so Zed threads stop showing "New Agent Thread". Without this extension (or a manual `/name`), threads stay untitled.

## Install

```sh
mkdir -p ~/.pi/agent/extensions
cp /Users/xikxp1/Projects/pi-acp/extensions/pi-acp-session-title.ts ~/.pi/agent/extensions/pi-acp-session-title.ts
```

Restart pi or run `/reload`. Re-copy after changing the file in this repo.

# Subagent output extension

`pi-acp-subagents.ts` exposes live output from top-level `@tintinweb/pi-subagents` agents as expandable ACP tool cards in Zed. The ordinary `Agent` tool result confirms the spawn; the separate subagent card continues updating until the child finishes, even after the parent turn ends.

## Install

Install `@tintinweb/pi-subagents` in Pi if it is not already installed. Then, from this repository's root:

```sh
mkdir -p ~/.pi/agent/extensions
cp extensions/pi-acp-subagents.ts ~/.pi/agent/extensions/pi-acp-subagents.ts
```

Restart the ACP session after installation. Use the updated pi-acp adapter as well as the extension, and re-copy the extension after updates. Installation is manual; pi-acp does not modify your global Pi configuration or automatically load the file.

The extension activates only in RPC mode with `PI_ACP_SUBAGENTS=1`, which pi-acp sets on its subprocesses. Normal terminal Pi remains unchanged. It uses the lifecycle events and in-process manager registry of `@tintinweb/pi-subagents` (integration targeted at version 0.19.0); there is no hard dependency or additional socket. If the compatible registry is unavailable, live output is unavailable rather than changing agent execution.

## Display and limitations

- Separate cards show running/completed/failed status, assistant text, and tool calls/results. Pending (queued) cards are available only for background `Agent` launches/resumes. Queued foreground and RPC launches emit no `subagents:created` upstream: their cards appear only when started, and cancellation while queued produces no card. Background spawn completion does not prematurely finish the child card.
- Snapshots update at approximately 250 ms intervals and replace the previous content. Unchanged output is not resent. Tool output appears when its result is available; partial shell output is not streamed separately.
- The visible transcript is bounded to roughly the last 64 Ki characters, with an explicit truncation notice. Snapshots reflect the child's retained message history, so child compaction can remove earlier output. An output-file location is included when pi-subagents supplies one; transcript files may be disabled in that extension's settings.
- The adapter tracks at most 4096 live-card runs per ACP session, including completed runs. Start a new session to display additional runs after that limit.
- User/system prompts, inherited parent history, and thinking blocks are not included in the live card. The bridge never adds its snapshots to model context or consumes the child's result.
- Only top-level launches and background resumes are supported. Workflow-owned and nested children are excluded by the upstream manager/event interface. Foreground resumes currently emit no lifecycle events upstream and fall back to their ordinary tool result. This is not Zed's native child-session UI.
- Live cards are ephemeral. Reloaded session history still shows stored completion notifications and ordinary tool results, not a reconstruction of the live transcript.
- The bridge observes execution; it does not change cancellation or wait for background work. On bridge shutdown, active cards are marked disconnected/failed and observation stops.

Without this companion, pi-acp still displays stored custom completion messages and the progress/final output available from ordinary `Agent` calls.

# BTW side-question extension

`pi-btw.ts` adds a private, in-memory side conversation using the current model, thinking level, and model-registry credentials. It works in pi TUI and RPC (pi-acp / Zed).

## Install

From this repository's root:

```sh
mkdir -p ~/.pi/agent/extensions
cp extensions/pi-btw.ts ~/.pi/agent/extensions/pi-btw.ts
```

Remove `"npm:@narumitw/pi-btw"` from the `packages` array in `~/.pi/agent/settings.json` to avoid duplicate commands. Restart pi / the ACP session, or use `/reload` in TUI. Re-copy after updates. No build step is needed.

## Commands and display

- `/btw <question>` starts a side thread or asks a follow-up. Without arguments, it shows usage.
- `/btw:new <question>` discards the thread (cancelling a pending request) and captures fresh branch context.
- `/btw:bring` brings the latest successful answer to main. In TUI it prefills the editor with the answer, confirming before replacing an existing draft. In RPC it adds a displayed `btw` custom message containing the question and answer, without triggering a turn.

TUI shows a thinking status followed by a Markdown viewer for the latest Q/A. Use arrows or PgUp/PgDn to scroll; Esc or q closes. RPC sends the complete Q/A as a Markdown notification, rendered by pi-acp in Zed. Errors also use notifications. Side questions and answers never enter main history/context unless explicitly brought back (and, in TUI, submitted).

## Limitations

- Threads are memory-only and reset on session start, replacement, reload, and shutdown. Tree navigation within one session keeps the side thread; use `/btw:new` for a fresh background snapshot.
- Background is capped at 40,000 characters, keeping recent branch user/assistant text and short tool-call summaries. Images, thinking, tool results, and compaction summaries are omitted. Follow-ups retain their side history without automatic compaction; use `/btw:new` for long threads.
- No tools, streaming answer display, model picker, persistence, or usage accounting in main-session totals. Calls still incur provider usage. Current pi-ai no longer exports standalone `completeSimple` from its root, so the extension uses the old extension's equivalent registry-provider `streamSimple(...).result()` with resolved auth, headers, environment, and base URL.
- Cancellation honors `ctx.signal` when present and aborts on replacement/shutdown. Idle extension commands normally have no `ctx.signal`, so RPC abort / TUI Esc may not cancel the request; `/btw:new <question>` replaces it. A second `/btw` is rejected while one is pending.
- Print/JSON modes have no notification UI. The supported display modes are TUI and RPC.

# Todo extension

`pi-acp-todo.ts` adds a minimal `todo` tool for planning and tracking multi-step tasks, with a compact TUI checklist. Every call replaces the full list; send `{ "todos": [] }` to clear it. Keep at most one item `in_progress`.

## Details contract

Parameters are `{ todos: [{ content, status, priority? }] }`. Status is `pending`, `in_progress`, or `completed`; priority is `high`, `medium`, or `low` (defaults to `medium`).

Every result's `details` is exactly `{ todos: [{ content, status, priority }] }`, with priority always present. Invalid input returns an error and the unchanged previous list. A `tool_result` hook sets pi's error flag and preserves details even when pi rejects arguments before execution. State is restored from the current session branch on session start and tree navigation.

## Install

With pi installed, create its global extensions directory if needed, then symlink this file:

```sh
mkdir -p ~/.pi/agent/extensions
cp /Users/xikxp1/Projects/pi-acp/extensions/pi-acp-todo.ts ~/.pi/agent/extensions/pi-acp-todo.ts
```

Restart pi or run `/reload`. Re-copy after changing the file in this repo. Do not load another extension registering `todo` alongside this one.
