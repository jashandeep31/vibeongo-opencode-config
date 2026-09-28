# VibeOnGo tools and credentials

The configured `vibeongo` MCP server runs through `vibeongo mcp` over stdio. It is separate from `vibeongo serve`, the runtime HTTP and WebSocket service. MCP repository tools accept `reponame` as the project's configured short name or `owner/repository` full name. They support configured GitHub and Forgejo repositories and load their repository-scoped credentials internally, renewing them when required.

| Need | MCP tool and main inputs |
| --- | --- |
| Read one issue or PR | `get-repository-item`: `reponame`, `type` (`issue` or `pr`), positive `number` |
| List issues or PRs | `list-repository-items`: `reponame`, `type`; optional `state`, `page`, `count` |
| Create an issue | `raise-issue`: `reponame`, `title`, optional `body` |
| Create a PR | `raise-pr`: `reponame`, `title`, `body`, source `head`, destination `base` |
| Comment or review | `comment-repository-item`: `reponame`, `type`, `number`, `action`, body and optional inline review comments |
| Run Git | `git-command`: `reponame`, Git `args` array |
| Get more provider data | `provider-api-get`: `reponame`, full API `url` |
| Perform a provider JSON POST | `provider-api-post`: `reponame`, full API `url`, optional JSON `body` |
| Find preview URLs | `get-runtime-domains`: no repository name needed |

For `comment-repository-item`, actions are `comment`, `review`, `approve`, and `request_changes`; review actions apply to PRs, not issues. Inline review comments use a changed file path, positive line, `LEFT` or `RIGHT` side, and body. Choose the action that matches the user's request and report a provider rejection honestly.

`git-command` allows `add`, `branch`, `checkout`, `commit`, `diff`, `fetch`, `log`, `pull`, `push`, `restore`, `show`, `status`, and `switch`. For `fetch`, `pull`, and `push`, include `origin` in the arguments; the tool inserts the scoped credential temporarily and redacts it from output. It runs in the configured repository folder. Check status and branch before changing anything, preserve unrelated work, and use the task's intended base and branch.

Provider API GET and POST accept only a complete URL on the configured provider API origin and within the configured `/repos/{owner}/{repo}` path. They reject other hosts and repositories. Use a dedicated MCP tool when one exists; use `provider-api-get` for additional repository details such as PR files, comments, commits, or checks. `provider-api-post` can change provider state, so use it only for an operation requested by the task.

## CLI and secrets

Run `vibeongo --help` or a subcommand's `--help` when MCP lacks a needed VibeOnGo operation. Relevant commands include `domains` for proxy domain information, `config get-scripts` for local project scripts, and `dev-script` for a full restart of the `dev` tmux session. Do not assume the CLI has issue or PR commands just because MCP does.

`vibeongo get-keys` prints the runtime session token and repository tokens. The local configuration and agent auth files also contain secrets. Do not read or expose them for routine repository operations; MCP handles authentication. Avoid writing credentials into remote URLs or logs. If direct credentials are genuinely necessary for the assigned task, limit their handling and keep them out of outputs and commits.
