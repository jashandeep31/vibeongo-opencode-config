import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const WEBHOOK_URL = "http://127.0.0.1:3102/webhook/opencode"
const TOKEN_PATH = join(homedir(), ".config", "vibeongo", "webhook-token.txt")

// read on every request so a token created after opencode started is still picked up
async function readToken() {
  const token = (await readFile(TOKEN_PATH, "utf8")).trim()
  if (!token) throw new Error(`token file is empty: ${TOKEN_PATH}`)
  return token
}

// events that need the user, forwarded to the webhook
const WEBHOOK_EVENTS = new Set([
  "session.execution.succeeded", // the agent finished
  "session.execution.failed", // the agent stopped with an error
  "session.execution.interrupted", // only the reasons in NOTIFY_INTERRUPT_REASONS
  "form.created", // the agent asks the user a question
  "permission.asked", // the agent waits for a permission
])

// "user", "shutdown" and "superseded" are stopped on purpose, nothing to tell
const NOTIFY_INTERRUPT_REASONS = new Set(["inactivity"])

// subagents run inside a main chat: their questions and permission requests
// block that chat, so they are sent for it; their own runs ending are not
const SUBAGENT_EVENTS_TO_NOTIFY = new Set(["form.created", "permission.asked"])

// the opencode session an event belongs to
const sessionIDOf = (event) =>
  event.type === "form.created" ? event.data?.form?.sessionID : event.data?.sessionID

// the main chat a session belongs to, walking up from subagents
async function resolveChat(ctx, sessionID) {
  let session = await ctx.session.get({ sessionID })
  const isSubagent = Boolean(session.parentID)
  // subagents can nest, never deeply
  for (let depth = 0; session.parentID && depth < 10; depth++) {
    session = await ctx.session.get({ sessionID: session.parentID })
  }
  return { session, isSubagent }
}

// short text about what happened, shown in the notification body
function detailOf(event) {
  switch (event.type) {
    case "session.execution.failed":
      return event.data?.error?.message
    case "session.execution.interrupted":
      return event.data?.reason
    case "form.created":
      return event.data?.form?.title
    case "permission.asked":
      return (
        event.data?.message ??
        [event.data?.action, ...(event.data?.resources ?? [])].filter(Boolean).join(" ")
      )
  }
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

// opencode's placeholder for a chat that has no title yet
const UNTITLED_PATTERN = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/

// the chat's real title, undefined when it has none
function chatTitleOf(session) {
  const title = session?.title?.trim()
  if (!title || UNTITLED_PATTERN.test(title)) return undefined
  return truncate(title, MAX_TITLE_LENGTH)
}

// title and body written by the notification agent with the chat's own model,
// undefined on any failure so the server falls back to its default text
async function craftNotification(ctx, sessionID, session) {
  try {
    const [messages, agent] = await Promise.all([
      ctx.session.context({ sessionID }),
      ctx.agent.get({ agentID: NOTIFICATION_AGENT_ID }).catch(() => undefined),
    ])

    const conversation = recentConversation(messages)
    if (!conversation) return undefined

    const prompt = [
      agent?.system ?? NOTIFICATION_PROMPT,
      `Chat title: ${chatTitleOf(session) ?? "Untitled"}`,
      `Last messages:\n${conversation}`,
    ].join("\n\n")

    // a model set on the agent in the user's config wins, otherwise the chat's model
    const model = agent?.model ?? session.model
    let result
    try {
      // cheap: only the title and last messages, no session attached
      result = await withTimeout(
        ctx.generate.text({ prompt, ...(model ? { model } : {}) }),
        GENERATE_TIMEOUT_MS,
      )
    } catch {
      // opencode's free tier rejects requests without session headers ("can only be used
      // from within OpenCode"); session.generate sends them, but with the whole chat as
      // context, so it is only the fallback. It never writes to the session.
      result = await withTimeout(
        ctx.session.generate({ sessionID, prompt: agent?.system ?? NOTIFICATION_PROMPT }),
        GENERATE_TIMEOUT_MS,
      )
    }
    return parseNotification(result.text)
  } catch {
    return undefined
  }
}

async function sendWebhook(ctx, event) {
  try {
    if (
      event.type === "session.execution.interrupted" &&
      !NOTIFY_INTERRUPT_REASONS.has(event.data?.reason)
    )
      return

    const sessionID = sessionIDOf(event)
    // "global" is the owner of MCP elicitation forms, not a chat
    const chat =
      sessionID && sessionID !== "global"
        ? await resolveChat(ctx, sessionID).catch(() => undefined)
        : undefined
    if (chat?.isSubagent && !SUBAGENT_EVENTS_TO_NOTIFY.has(event.type)) return

    const chatTitle = chatTitleOf(chat?.session)
    const detail = detailOf(event)?.trim()
    // only a finished run gets AI written text: the others are urgent and
    // their default text with the detail says what is needed
    const notification =
      event.type === "session.execution.succeeded" && chat
        ? await craftNotification(ctx, chat.session.id, chat.session)
        : undefined
    const token = await readToken()
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // chatSessionID is the main chat to open (differs for subagents),
      // chatTitle and detail let the server's default text say what happened
      body: JSON.stringify({
        ...event,
        ...(chat ? { chatSessionID: chat.session.id } : {}),
        ...(chatTitle ? { chatTitle } : {}),
        ...(detail ? { detail: truncate(detail, MAX_BODY_LENGTH) } : {}),
        ...(notification ? { notification } : {}),
      }),
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
          if (!WEBHOOK_EVENTS.has(event.type)) continue

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
