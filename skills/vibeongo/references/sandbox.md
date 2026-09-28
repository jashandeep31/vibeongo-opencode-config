# Sandbox layout and lifecycle

## How a session starts

1. The central VibeOnGo platform creates a session and allocates a VM or sandbox. Its project blueprint specifies repositories, scripts, services, ports, agent settings, and runtime expiration.
2. Bootstrap fetches the session configuration into the runtime user's `~/.config/vibeongo/config.json`, installs or updates `vibeongo`, and provisions configured tools and Docker services.
3. The initial script runs in `~/workspace`; repositories are cloned into their configured folders. Per-repository setup scripts run in those folders, and project files are placed under `~/workspace` at their configured paths.
4. The final setup script runs, then `vibeongo dev-script` starts the configured dev commands in the `dev` tmux session. Agent tasks run afterward in the `tasks` tmux session. For repeated tasks in the same repository, OpenCode may continue an earlier conversation.
5. The runtime can expire or be terminated. Session records remain on the platform; processes and local files in the temporary runtime may not.

## Where things are

| Item | Typical location or process |
| --- | --- |
| Workspace root | `~/workspace` |
| Each repository | `~/workspace/<folder_name>` from project configuration |
| Runtime configuration | `~/.config/vibeongo/config.json` (sensitive) |
| Bootstrap log | `~/.logs/vibeongo.log` |
| Dev servers and watchers | tmux session `dev`, one or more windows |
| Automated agent tasks | tmux session `tasks` |
| OpenCode web service | tmux session `ops`, normally on port `4096` |
| Go runtime HTTP and WebSocket service | `vibeongo serve`, normally on port `3101` |
| Optional T3 Code service | tmux session `t3Code` when configured |
| Optional agent auth files | Under the runtime user's OpenCode, Codex, Pi, or FX directories; treat as secrets |

The runtime uses the current user's home directory for `~/workspace`; the bootstrap script defaults to a user named `vibe`, but deployments can choose another username. Do not hardcode `/home/vibe` when `~` or `$HOME` works.

## Working with the dev session

Before starting a server, inspect the existing session and windows, for example with `tmux has-session -t dev`, `tmux list-windows -t dev`, and `tmux list-panes -t dev -a`. Inspect the relevant pane's recent output when needed. Match the window to the repository and port in the task. A `dev` session can contain several unrelated commands; do not interrupt another project's server.

If the desired server is already running, use it. If a new or restarted server is needed, run it in the appropriate `dev` session window. Create a new window there if needed. When no `dev` session exists, create it or run the configured `vibeongo dev-script` if the full configured stack is needed. That CLI command kills and recreates `dev`, so do not invoke it merely to inspect or restart one window.

The project can define multiple dev commands separated by a line containing `---`; the runtime starts the first in the initial `dev` window and later commands in additional windows. tmux keeps these processes alive when a browser or mobile client disconnects.

## Previews and local services

`get-runtime-domains` returns each assigned domain, target port, stable identifier, and editability. Start with the actual local service and port, then use its matching domain to test or share a preview. Other configured services may run in Docker Compose. The platform proxy and domain settings determine which local ports receive external HTTPS URLs.

The `ops` tmux session and OpenCode port `4096` are for the agent service. The Go runtime's port `3101` serves local HTTP and WebSocket controls. Neither port should be mistaken for the project's application port.
