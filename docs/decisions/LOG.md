# Decision log

## 2026-10-06 - Ultracode / dynamic workflows

Plan: [docs/plans/ultracode-workflows.md](../plans/ultracode-workflows.md)

| #   | Decision                         | Chosen                                                                                                              | Rejected                                                                          |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Approach                         | Dedicated `workflow` tool with a script runtime (Claude Code parity)                                                | Prompt-only orchestration; codemode; delegating to `claude -p --effort ultracode` |
| 2   | Package location                 | New `pi-workflows` package importing `pi-subagents/runner.mjs`                                                      | Extending pi-subagents; copying the runner                                        |
| 3   | Sandbox                          | `quickjs-wasi` resolved from Pi's `node_modules`                                                                    | Own dependency; `node:vm`; reusing codemode                                       |
| 4   | Execution                        | Background runs, result delivered as a follow-up message                                                            | Foreground; foreground first                                                      |
| 5   | Run ownership across pi restarts | Detached supervisor process per run, reattached by the extension                                                    | Interrupt + relaunch                                                              |
| 6   | Resume                           | Full replay across restarts from an on-disk journal                                                                 | In-process only; none                                                             |
| 7   | Zed progress                     | Per-agent child views linked from the workflow tool call                                                            | Text-only progress; workflow child session                                        |
| 8   | Card lifetime                    | Keep the workflow tool-call card alive until the run ends                                                           | Synthetic tool calls; blocking `workflow_wait`                                    |
| 9   | Multiple links per card          | Patch Zed to support a list of child links (`subagent_sessions_info`)                                               | Nested workflow session; synthetic per-agent cards; workflow-level view only      |
| 10  | Toggles                          | `/ultracode`, human-typed keyword, config setting, plus a Zed config option                                         | Without Zed option; keyword only                                                  |
| 11  | Thinking level                   | Ultracode does not change thinking                                                                                  | Set `xhigh` and restore                                                           |
| 12  | Script API                       | Claude Code API (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `schema`) plus `retry`, `until`, `budget` | Exact mirror only; custom API                                                     |
| 13  | Approval                         | Ask once per session; ultracode on skips the prompt and the large-workflow warning                                  | Per-run prompt; never ask                                                         |
| 14  | File isolation                   | Opt-in `isolation: "worktree"`                                                                                      | Shared tree only; read-only by default                                            |
| 15  | Worktree base                    | Snapshot including uncommitted and untracked files; per-agent branches kept, worktree dirs removed; no auto-merge   | `HEAD` only; auto-merge                                                           |
| 16  | Saved workflows                  | `.pi/workflows/` and `<agentDir>/workflows/` as `/<name>` commands                                                  | Also loading `.claude/workflows/`; none in v1                                     |
| 17  | Plan location                    | `pi-acp/docs/plans/` + this log                                                                                     | Package README; chat only                                                         |
