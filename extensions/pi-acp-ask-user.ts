export const ASK_USER_TOOL = 'ask_user'

export const ASK_USER_ACP_GUIDELINES: readonly string[] = [
  'This session runs in an ACP client (e.g. Zed) that shows the ask_user question as a single truncated line, hides option descriptions, and renders the ask_user context field as Markdown in the question card. The user cannot see your thinking, so put all decision material in the context field itself.',
  'For an ask_user call with 2+ options, the context field must contain: a short situation summary (findings, constraints); a Markdown comparison table with one row per option (e.g. Option | What changes | Pros | Cons/risks | Effort/reversibility); a concrete example per option (code snippet, command, config, or resulting behavior); and your recommendation with a one-line reason.',
  'Make the ask_user context self-contained: never point to a table or explanation "above" or elsewhere instead of including it.',
  'Keep the ask_user question to one short line and use option titles that exactly match the table rows (e.g. prefixed with A., B., C.).',
  'For a freeform ask_user question or a simple yes/no confirmation, still explain in the context field what you need and why, with an example of a useful answer; the table is not required.'
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
