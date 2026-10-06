import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { UpdateSink } from './client-link.js'
import { SessionManager, type PiAcpSession } from './session.js'
import { SessionStore } from './session-store.js'
import { SubagentSessions } from './subagent-sessions.js'

/** Forwards to the most recently attached client (subagent inspection follows the newest viewer). */
export class LatestClient implements UpdateSink {
  private client: UpdateSink | null = null

  attach(client: UpdateSink): void {
    this.client = client
  }

  detach(client: UpdateSink): void {
    if (this.client === client) this.client = null
  }

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.client?.sessionUpdate(params) ?? Promise.resolve()
  }
}

export type AgentRuntimeOptions = {
  /** Sessions outlive client connections (daemon mode). */
  durable: boolean
  /** How long a detached session waits for a client to answer permission/input requests. */
  detachedInputTimeoutMs?: number
}

/**
 * State shared by every ACP connection served by one process. In stdio mode each
 * connection owns a private runtime; the daemon shares one across reconnecting clients.
 */
export class AgentRuntime {
  readonly sessions = new SessionManager()
  readonly store = new SessionStore()
  readonly restoringSessions = new Map<string, Promise<PiAcpSession>>()
  readonly subagentClient = new LatestClient()
  readonly subagentSessions = new SubagentSessions(this.subagentClient)

  constructor(readonly options: AgentRuntimeOptions = { durable: false }) {}
}
