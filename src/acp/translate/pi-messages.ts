export function normalizePiMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}

export function normalizePiAssistantThinking(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'thinking' && typeof c.thinking === 'string' ? c.thinking : ''))
    .filter(Boolean)
    .join('\n\n')
}

export type PiImageBlock = { type: 'image'; data: string; mimeType: string }

export function piImageBlocks(content: unknown): PiImageBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (c: any): c is PiImageBlock => c?.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string'
  )
}

export function normalizePiAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('')
}
