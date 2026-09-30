import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const WEBHOOK_URL = "http://localhost:3101/webhook/opencode"
const TOKEN_PATH = join(homedir(), ".config", "vibeongo", "webhook-token.txt")

// read on every request so a token created after opencode started is still picked up
async function readToken() {
  const token = (await readFile(TOKEN_PATH, "utf8")).trim()
  if (!token) throw new Error(`token file is empty: ${TOKEN_PATH}`)
  return token
}

// session events forwarded to the webhook; add "session.execution.failed" etc. here later
const WEBHOOK_EVENTS = new Set(["session.execution.succeeded"])

// subagent (child) sessions: opencode sends execution events for them too, but the
// user only cares about the main session, so every forwarded event is filtered by this
const subagentSessions = new Set()

function trackSubagentSessions(event) {
  if (event.type === "session.created" && event.data?.parentID) {
    subagentSessions.add(event.data.sessionID)
  } else if (event.type === "session.deleted") {
    subagentSessions.delete(event.data?.sessionID)
  }
}

function isSubagentSession(sessionID) {
  return subagentSessions.has(sessionID)
}

export default {
  id: "session-success-webhook",
  setup(ctx) {
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          trackSubagentSessions(event)
          if (!WEBHOOK_EVENTS.has(event.type)) continue
          if (isSubagentSession(event.data?.sessionID)) continue

          try {
            const token = await readToken()
            const response = await fetch(WEBHOOK_URL, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: token },
              body: JSON.stringify(event),
              signal: AbortSignal.timeout(5000),
            })
            if (!response.ok) {
              console.error(`session-success-webhook: HTTP ${response.status}`)
            }
          } catch (error) {
            console.error("session-success-webhook: webhook request failed", error)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("session-success-webhook: event subscription failed", error)
        }
      }
    })()

    return () => controller.abort()
  },
}
