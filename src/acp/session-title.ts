export function titleFromContent(content: unknown): string | null {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (block: unknown): block is { type: 'text'; text: string } =>
          block !== null &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
      )
      .map(block => block.text)
      .join(' ')
  } else {
    return null
  }

  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized ? Array.from(normalized).slice(0, 80).join('') : null
}
