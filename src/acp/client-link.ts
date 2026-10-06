import type { AgentSideConnection } from '@agentclientprotocol/sdk'

/** The client-facing operations a session needs. A raw `AgentSideConnection` satisfies it. */
export type SessionClient = Pick<
  AgentSideConnection,
  | 'sessionUpdate'
  | 'requestPermission'
  | 'unstable_createElicitation'
  | 'readTextFile'
  | 'writeTextFile'
  | 'createTerminal'
> & { readonly signal?: AbortSignal }

export type UpdateSink = Pick<AgentSideConnection, 'sessionUpdate'>

type SessionNotification = Parameters<SessionClient['sessionUpdate']>[0]

export const DEFAULT_DETACHED_INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000

export type ClientLinkOptions = {
  /** Durable links survive client disconnects and wait for a client to reattach. */
  durable?: boolean
  /** How long a permission/elicitation request waits for a client while detached. */
  detachedInputTimeoutMs?: number
}

export class ClientDetachedError extends Error {
  constructor() {
    super('ACP client is not attached')
    this.name = 'ClientDetachedError'
  }
}

/**
 * Indirection between a session and the ACP client currently viewing it.
 *
 * Non-durable links (stdio mode) are bound to one connection forever and behave like the
 * raw connection. Durable links (daemon mode) can be detached when the client disconnects
 * and reattached to a later connection: output produced while detached is dropped (the
 * session replays a snapshot on reattach), filesystem and terminal delegation fail fast so
 * pi falls back to local execution, and user-input requests wait for the next client.
 */
export class ClientLink implements SessionClient {
  private client: SessionClient | null
  private readonly waiters = new Set<() => void>()
  private detachedSince: number | undefined
  // Settles once a reattached client has received its replay; input requests wait for it.
  private ready: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    client: SessionClient | null,
    private readonly options: ClientLinkOptions = {}
  ) {
    this.client = client
    if (!client) this.detachedSince = Date.now()
  }

  get durable(): boolean {
    return Boolean(this.options.durable)
  }

  get attached(): SessionClient | null {
    return this.client
  }

  /** Epoch ms when the link lost its client, or undefined while attached. */
  get detachedAt(): number | undefined {
    return this.detachedSince
  }

  /** Route output to `client` now; deliver user-input requests only after `ready` settles. */
  attach(client: SessionClient, ready?: Promise<unknown>): void {
    if (this.client === client && !ready) return
    this.client = client
    this.detachedSince = undefined
    this.ready = (ready ?? Promise.resolve()).then(
      () => {},
      () => {}
    )
    this.notifyChange()
  }

  /** Detach only if `client` is the current one; a newer client keeps the link. */
  detach(client: SessionClient): boolean {
    if (this.client !== client) return false
    this.client = null
    this.detachedSince = Date.now()
    this.notifyChange()
    return true
  }

  /** The session is gone: pending and future user-input requests resolve as cancelled. */
  close(): void {
    this.closed = true
    this.notifyChange()
  }

  /**
   * Where a session update generated now must go. Callers capture this at generation
   * time so output produced before a handoff never reaches the next client after its replay.
   */
  outputTarget(): UpdateSink | null {
    return this.client
  }

  /**
   * Deliver an update captured for `target`. Stops waiting as soon as `target` is
   * superseded, so a stalled old connection cannot block the next client's replay.
   */
  async deliver(target: UpdateSink, params: SessionNotification): Promise<void> {
    if (this.client !== target) return
    const change = this.nextChange()
    try {
      await Promise.race([target.sessionUpdate(params), change.promise])
    } finally {
      change.dispose()
    }
  }

  sessionUpdate(params: SessionNotification): Promise<void> {
    const target = this.client
    return target ? this.deliver(target, params) : Promise.resolve()
  }

  requestPermission(
    params: Parameters<SessionClient['requestPermission']>[0]
  ): ReturnType<SessionClient['requestPermission']> {
    return this.request<Awaited<ReturnType<SessionClient['requestPermission']>>>(
      client => client.requestPermission(params),
      () => ({ outcome: { outcome: 'cancelled' } })
    )
  }

  unstable_createElicitation(
    params: Parameters<SessionClient['unstable_createElicitation']>[0]
  ): ReturnType<SessionClient['unstable_createElicitation']> {
    return this.request<Awaited<ReturnType<SessionClient['unstable_createElicitation']>>>(
      client => client.unstable_createElicitation(params),
      () => ({ action: 'cancel' })
    )
  }

  async readTextFile(params: Parameters<SessionClient['readTextFile']>[0]) {
    return this.require().readTextFile(params)
  }

  async writeTextFile(params: Parameters<SessionClient['writeTextFile']>[0]) {
    return this.require().writeTextFile(params)
  }

  async createTerminal(params: Parameters<SessionClient['createTerminal']>[0]) {
    return this.require().createTerminal(params)
  }

  private require(): SessionClient {
    if (!this.client) throw new ClientDetachedError()
    return this.client
  }

  private nextChange(): { promise: Promise<void>; dispose: () => void } {
    let waiter!: () => void
    const promise = new Promise<void>(resolve => {
      waiter = resolve
      this.waiters.add(waiter)
    })
    return { promise, dispose: () => this.waiters.delete(waiter) }
  }

  private notifyChange(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const waiter of waiters) waiter()
  }

  private async waitForClient(deadline: number): Promise<SessionClient | null> {
    while (!this.client) {
      if (this.closed) return null
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      const change = this.nextChange()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([change.promise, new Promise<void>(resolve => (timer = setTimeout(resolve, remaining)))])
      } finally {
        clearTimeout(timer)
        change.dispose()
      }
    }
    return this.client
  }

  /**
   * Durable requests follow the client: if it disconnects or another client takes over
   * before answering, the request is re-issued to the next client.
   */
  private async request<T>(send: (client: SessionClient) => Promise<T>, onTimeout: () => T): Promise<T> {
    if (!this.durable) return send(this.require())
    const deadline = Date.now() + (this.options.detachedInputTimeoutMs ?? DEFAULT_DETACHED_INPUT_TIMEOUT_MS)
    for (;;) {
      if (this.closed) return onTimeout()
      const client = this.client ?? (await this.waitForClient(deadline))
      if (!client || this.closed) return onTimeout()
      const ready = this.ready
      await ready
      if (this.client !== client || this.ready !== ready) continue
      const change = this.nextChange()
      try {
        const outcome = await Promise.race([
          send(client).then(
            value => ({ value }),
            (error: unknown) => ({ error })
          ),
          change.promise.then(() => undefined)
        ])
        if (outcome === undefined) continue
        if ('value' in outcome) return outcome.value
        if (client.signal?.aborted) {
          this.detach(client)
          continue
        }
        if (this.client !== client) continue
        throw outcome.error
      } finally {
        change.dispose()
      }
    }
  }
}

export function toClientLink(client: SessionClient | ClientLink): ClientLink {
  return client instanceof ClientLink ? client : new ClientLink(client)
}
