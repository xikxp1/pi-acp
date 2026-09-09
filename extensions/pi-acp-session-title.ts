import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const MAX_TITLE_LENGTH = 80

export function deriveSessionTitle(message: string): string | null {
  const firstLine = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0)

  if (!firstLine || firstLine.startsWith('/')) return null

  const collapsed = firstLine.replace(/\s+/g, ' ')
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}\u2026`
}

export default function (pi: ExtensionAPI) {
  pi.on('input', async (event, ctx) => {
    if (ctx.sessionManager.getSessionName()) return
    const title = deriveSessionTitle(event.text)
    if (title) pi.setSessionName(title)
  })
}
