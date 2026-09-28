export const ASK_USER_TOOL = 'ask_user'

export const ASK_USER_ACP_GUIDELINES: readonly string[] = [
  'This session runs in an ACP client (e.g. Zed) that shows the ask_user question as a single truncated line and may hide option descriptions, so put all decision material in your normal assistant message right before calling ask_user.',
  'Before an ask_user call with 2+ options, write in that message: a short situation summary (findings, constraints); a Markdown comparison table with one row per option (e.g. Option | What changes | Pros | Cons/risks | Effort/reversibility); a concrete example per option (code snippet, command, config, or resulting behavior); and your recommendation with a one-line reason.',
  'Keep the ask_user question to one short line, keep context to a brief pointer to the comparison above, and use option titles that exactly match the table rows (e.g. prefixed with A., B., C.).',
  'For a freeform ask_user question or a simple yes/no confirmation, still explain in the message what you need and why, with an example of a useful answer; the table is not required.'
]

export interface PromptOptions {
  toolGuidelines: Record<string, string[]>
}

export interface AskUserPi {
  on(
    event: 'before_agent_start',
    handler: (event: { systemPromptOptions: PromptOptions }, ctx: { mode?: string }) => void
  ): unknown
}

export function addAskUserGuidelines(options: PromptOptions): void {
  const existing = options.toolGuidelines[ASK_USER_TOOL] ?? []
  const missing = ASK_USER_ACP_GUIDELINES.filter(rule => !existing.includes(rule))
  if (missing.length) options.toolGuidelines[ASK_USER_TOOL] = [...existing, ...missing]
}

export default function piAcpAskUser(pi: AskUserPi): void {
  pi.on('before_agent_start', (event, ctx) => {
    if (process.env.PI_ACP_ASK_USER !== '1' || ctx.mode !== 'rpc') return
    addAskUserGuidelines(event.systemPromptOptions)
  })
}
