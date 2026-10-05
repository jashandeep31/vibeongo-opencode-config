import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const TOKEN_PATH = join(homedir(), ".config", "vibeongo", "webhook-token.txt")
const TOKEN_URL = "http://127.0.0.1:3102/internal/opencode/provider-credentials/codex/access-token"
const METHOD_ID = "chatgpt-token-sharing"
const MANAGED_PLACEHOLDER = "Managed by Vibeongo"

export default {
  id: "vibeongo-chatgpt-auth",
  async setup(ctx) {
    const lifecycle = new AbortController()
    // Share only an in-flight request. Never cache across account changes.
    let pending

    async function requestToken() {
      try {
        const pluginToken = (await readFile(TOKEN_PATH, "utf8")).trim()
        if (!pluginToken) throw new Error("missing plugin token")
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${pluginToken}` },
          redirect: "error",
          signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(35_000)]),
        })
        if (!response.ok) {
          await response.body?.cancel()
          if (response.status === 401 || response.status === 403) {
            throw new Error("Runtime authorization unavailable; reconnect the Vibeongo runtime")
          }
          if (response.status === 409) {
            throw new Error("ChatGPT connection unavailable; sign in again with the Vibeongo CLI")
          }
          throw new Error("ChatGPT renewal unavailable; try again")
        }
        // Bound the token-bearing response rather than parsing arbitrary bodies.
        const reader = response.body?.getReader()
        if (!reader) throw new Error("Invalid ChatGPT renewal response")
        const chunks = []
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 65_536) throw new Error("Invalid ChatGPT renewal response")
            chunks.push(value)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        let data
        try {
          data = JSON.parse(new TextDecoder().decode(bytes)).data
        } catch {
          throw new Error("Invalid ChatGPT renewal response")
        }
        const expires = typeof data?.access_token_expires_at === "string"
          ? Date.parse(data.access_token_expires_at)
          : NaN
        if (typeof data?.access_token !== "string" || !data.access_token.trim() ||
            !Number.isFinite(expires) || expires <= Date.now()) {
          throw new Error("Invalid ChatGPT renewal response")
        }
        return { access: data.access_token, expires }
      } catch (error) {
        // Only messages we construct may escape; parser/network errors can contain secrets.
        const safeMessages = new Set([
          "Runtime authorization unavailable; reconnect the Vibeongo runtime",
          "ChatGPT connection unavailable; sign in again with the Vibeongo CLI",
          "ChatGPT renewal unavailable; try again",
          "Invalid ChatGPT renewal response",
        ])
        throw new Error(safeMessages.has(error?.message)
          ? error.message
          : "ChatGPT renewal unavailable; check the Vibeongo runtime")
      }
    }

    await ctx.integration.transform((editor) => {
      const method = editor.method.list("openai").find((item) => item.id === METHOD_ID)
      if (!method || method.type !== "oauth") {
        throw new Error("Vibeongo ChatGPT auth requires OpenCode token-sharing support")
      }
      editor.method.update({
        integrationID: "openai",
        method: { ...method, label: "Vibeongo OpenAI" },
        authorize: async () => {
          throw new Error("Connect ChatGPT using the Vibeongo CLI, then reconnect this runtime")
        },
        refresh: async (credential) => {
          if (credential.type !== "oauth" || credential.methodID !== METHOD_ID ||
              credential.metadata?.managedBy !== "vibeongo") {
            throw new Error("This ChatGPT connection is not managed by Vibeongo; connect using the Vibeongo CLI")
          }
          if (lifecycle.signal.aborted) throw new Error("Vibeongo auth plugin stopped")
          if (!pending) {
            pending = requestToken().finally(() => { pending = undefined })
          }
          const token = await pending
          // OpenCode persists this value under the SAME credential ID.
          return {
            ...credential,
            ...token,
            refresh: MANAGED_PLACEHOLDER,
            metadata: { ...credential.metadata, clientID: MANAGED_PLACEHOLDER },
          }
        },
      })
    })
    return () => lifecycle.abort()
  },
}
