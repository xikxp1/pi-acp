import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

interface TodoDetails {
  todos: Todo[]
}

const TodoParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String(),
      status: StringEnum(['pending', 'in_progress', 'completed'] as const),
      priority: Type.Optional(StringEnum(['high', 'medium', 'low'] as const))
    })
  )
})

function parseTodos(value: unknown): Todo[] | string {
  if (typeof value !== 'object' || value === null || !('todos' in value) || !Array.isArray(value.todos)) {
    return 'todos must be an array'
  }
  const parsed: Todo[] = []
  for (const item of value.todos as unknown[]) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('content' in item) ||
      typeof item.content !== 'string' ||
      !item.content.trim()
    ) {
      return 'Each todo must have non-empty content'
    }
    if (
      !('status' in item) ||
      (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed')
    ) {
      return 'Each todo status must be pending, in_progress, or completed'
    }
    const priority = 'priority' in item && item.priority !== undefined ? item.priority : 'medium'
    if (priority !== 'high' && priority !== 'medium' && priority !== 'low') {
      return 'Each todo priority must be high, medium, or low'
    }
    parsed.push({ content: item.content, status: item.status, priority })
  }
  return parsed
}

function summary(todos: Todo[]): string {
  const completed = todos.filter(todo => todo.status === 'completed').length
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length
  return `${todos.length} todos: ${completed} completed, ${inProgress} in progress, ${todos.length - completed - inProgress} pending`
}

function checklist(todos: Todo[], theme: Theme, expanded: boolean): string {
  const display = expanded ? todos : todos.slice(0, 5)
  const lines = display.map(todo => {
    const marker =
      todo.status === 'completed'
        ? theme.fg('success', '✓')
        : todo.status === 'in_progress'
          ? theme.fg('accent', '→')
          : theme.fg('dim', '○')
    return `${marker} ${theme.fg(todo.status === 'completed' ? 'dim' : 'text', todo.content.replace(/\s+/g, ' '))}`
  })
  if (display.length < todos.length) lines.push(theme.fg('dim', `... ${todos.length - display.length} more`))
  return lines.join('\n')
}

export default function (pi: ExtensionAPI) {
  let todos: Todo[] = []
  const snapshot = (): TodoDetails => ({ todos: todos.map(todo => ({ ...todo })) })

  const reconstructState = (ctx: ExtensionContext) => {
    todos = []
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue
      const message = entry.message
      if (message.role !== 'toolResult' || message.toolName !== 'todo') continue
      const restored = parseTodos(message.details)
      if (typeof restored !== 'string') todos = restored
    }
  }

  pi.on('session_start', async (_event, ctx) => reconstructState(ctx))
  pi.on('session_tree', async (_event, ctx) => reconstructState(ctx))

  // Pi ignores execute's isError flag; this also preserves details for schema validation failures.
  pi.on('tool_result', async event => {
    if (event.toolName !== 'todo') return
    const parsed = parseTodos(event.input)
    if (typeof parsed !== 'string') return
    const previous = parseTodos(event.details)
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${parsed}` }],
      details: typeof previous === 'string' ? snapshot() : { todos: previous }
    }
  })

  pi.registerTool({
    name: 'todo',
    label: 'Todo',
    description:
      'Use todo to plan and track multi-step tasks. Each call replaces the entire list: always send the full updated list, marking at most one item in_progress. Send an empty list to clear it.',
    parameters: TodoParams,
    async execute(_toolCallId, params) {
      const parsed = parseTodos(params)
      if (typeof parsed === 'string') {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${parsed}` }],
          details: snapshot()
        }
      }
      todos = parsed
      return { content: [{ type: 'text', text: summary(todos) }], details: snapshot() }
    },
    renderCall(args, theme) {
      const parsed = parseTodos(args)
      const title = theme.fg('toolTitle', theme.bold('Todo'))
      return new Text(typeof parsed === 'string' ? title : `${title}\n${checklist(parsed, theme, false)}`, 0, 0)
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg('muted', 'Updating todos...'), 0, 0)
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      const parsed = parseTodos(result.details)
      const header = theme.fg(context.isError ? 'error' : 'muted', text)
      return new Text(
        typeof parsed === 'string' || parsed.length === 0 ? header : `${header}\n${checklist(parsed, theme, expanded)}`,
        0,
        0
      )
    }
  })
}
