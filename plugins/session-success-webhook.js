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

// hidden agent (like opencode's "title" agent): not in the agent list, no tools,
// only holds the prompt and an optional model override from the user's config
const NOTIFICATION_AGENT_ID = "notification"
const NOTIFICATION_PROMPT = `You write push notifications for a coding agent that just finished working.
You get the chat title and the last messages of the chat.
Reply with only a JSON object, no markdown: {"title": "...", "body": "..."}
- title: max 50 characters, what was done (e.g. "Fixed login redirect bug")
- body: max 150 characters, the outcome or what the user should check next
- plain text, no emojis, no quotes around file names, do not start with "I"`

// only the last exchanges are shared with the notification agent, never the full chat
const RECENT_EXCHANGES = 2
const MAX_MESSAGE_LENGTH = 2000
const GENERATE_TIMEOUT_MS = 20_000
const MAX_TITLE_LENGTH = 80
const MAX_BODY_LENGTH = 300

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

function assistantText(message) {
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

// last user messages and agent answers, oldest first
function recentConversation(messages) {
  const picked = []
  let users = 0
  for (let i = messages.length - 1; i >= 0 && users < RECENT_EXCHANGES; i--) {
    const message = messages[i]
    if (message.type === "user" && message.text?.trim()) {
      picked.push(`User: ${truncate(message.text.trim(), MAX_MESSAGE_LENGTH)}`)
      users++
    } else if (message.type === "assistant") {
      const text = assistantText(message)
      if (text) picked.push(`Agent: ${truncate(text, MAX_MESSAGE_LENGTH)}`)
    }
  }
  return picked.reverse().join("\n\n")
}

function parseNotification(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return undefined
  const parsed = JSON.parse(json)
  const title = typeof parsed.title === "string" ? parsed.title.trim() : ""
  const body = typeof parsed.body === "string" ? parsed.body.trim() : ""
  if (!title) return undefined
  return { title: truncate(title, MAX_TITLE_LENGTH), body: truncate(body, MAX_BODY_LENGTH) }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

// title and body written by the notification agent with the chat's own model,
// undefined on any failure so the server falls back to its default text
async function craftNotification(ctx, sessionID) {
  try {
    const [session, messages, agent] = await Promise.all([
      ctx.session.get({ sessionID }),
      ctx.session.context({ sessionID }),
      ctx.agent.get({ agentID: NOTIFICATION_AGENT_ID }).catch(() => undefined),
    ])

    const conversation = recentConversation(messages)
    if (!conversation) return undefined

    const prompt = [
      agent?.system ?? NOTIFICATION_PROMPT,
      `Chat title: ${session.title ?? "Untitled"}`,
      `Last messages:\n${conversation}`,
    ].join("\n\n")

    // a model set on the agent in the user's config wins, otherwise the chat's model
    const model = agent?.model ?? session.model
    const result = await withTimeout(
      ctx.generate.text({ prompt, ...(model ? { model } : {}) }),
      GENERATE_TIMEOUT_MS,
    )
    return parseNotification(result.text)
  } catch (error) {
    console.error("session-success-webhook: could not craft notification", error)
    return undefined
  }
}

async function sendWebhook(ctx, event) {
  try {
    const notification = await craftNotification(ctx, event.data.sessionID)
    const token = await readToken()
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ ...event, ...(notification ? { notification } : {}) }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      console.error(`session-success-webhook: HTTP ${response.status}`)
    }
  } catch (error) {
    console.error("session-success-webhook: webhook request failed", error)
  }
}

export default {
  id: "session-success-webhook",
  async setup(ctx) {
    const controller = new AbortController()

    await ctx.agent.transform((editor) => {
      editor.update(NOTIFICATION_AGENT_ID, (agent) => {
        agent.name = "Notification"
        agent.mode = "primary"
        agent.hidden = true
        agent.system = NOTIFICATION_PROMPT
        agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })
    })

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          trackSubagentSessions(event)
          if (!WEBHOOK_EVENTS.has(event.type)) continue
          if (isSubagentSession(event.data?.sessionID)) continue

          // not awaited: generating the text takes seconds and must not block the event stream
          void sendWebhook(ctx, event)
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
