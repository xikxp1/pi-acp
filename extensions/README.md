# Todo extension

`pi-acp-todo.ts` adds a minimal `todo` tool for planning and tracking multi-step tasks, with a compact TUI checklist. Every call replaces the full list; send `{ "todos": [] }` to clear it. Keep at most one item `in_progress`.

## Details contract

Parameters are `{ todos: [{ content, status, priority? }] }`. Status is `pending`, `in_progress`, or `completed`; priority is `high`, `medium`, or `low` (defaults to `medium`).

Every result's `details` is exactly `{ todos: [{ content, status, priority }] }`, with priority always present. Invalid input returns an error and the unchanged previous list. A `tool_result` hook sets pi's error flag and preserves details even when pi rejects arguments before execution. State is restored from the current session branch on session start and tree navigation.

## Install

With pi installed, create its global extensions directory if needed, then symlink this file:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s /Users/xikxp1/Projects/pi-acp/extensions/pi-acp-todo.ts ~/.pi/agent/extensions/pi-acp-todo.ts
```

Restart pi or run `/reload`. Do not load another extension registering `todo` alongside this one.
