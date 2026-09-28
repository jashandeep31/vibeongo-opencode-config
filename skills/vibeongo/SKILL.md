---
name: vibeongo
description: "Navigate and work inside a VibeOnGo managed sandbox or VM: locate its repositories and runtime services, use the dev tmux session and preview domains, and choose the VibeOnGo MCP or CLI for repository operations."
---

# VibeOnGo runtime

Use this skill when a coding, issue, review, or automation task runs inside a VibeOnGo workspace. VibeOnGo prepares an isolated runtime from a project configuration, clones the project's repositories, starts configured services, and runs agent tasks there. A project may have multiple repositories, so use the repository identified by the task rather than assuming the current directory is the only one.

## First orientation

- The workspace root is `~/workspace`. Each configured repository is under `~/workspace/<folder_name>`; the folder name is set by the project and may differ from the repository name. Check `pwd`, the task context, and local Git metadata to identify the right repository.
- The runtime configuration is normally `~/.config/vibeongo/config.json`. It includes tokens and repository credentials: do not print, paste, commit, or casually read it. The CLI can fall back to `./config.json` when the normal path is absent.
- Project files may be placed at configured paths under `~/workspace`. The runtime can also provision Docker Compose services and language or agent tooling. Inspect the current environment before installing or starting duplicates.
- The `dev` tmux session holds the configured long-running development script, possibly across multiple windows. Check its windows and panes before starting a dev server. Reuse a running server, and start or restart dev servers only within the appropriate `dev` window. `vibeongo dev-script` replaces the entire `dev` session, so use it only when a full restart is intended.
- Prefer VibeOnGo MCP for supported repository and provider actions. It supplies scoped credentials. If MCP does not cover a needed VibeOnGo action, check `vibeongo --help` and the relevant subcommand. Use ordinary project tools for editing, tests, builds, and local inspection. Avoid `vibeongo get-keys`: it prints secrets.
- Use `get-runtime-domains` to discover the HTTPS preview URL and target port for a running local service. A local port is externally reachable only when the project has a matching proxy domain.

Read [references/sandbox.md](references/sandbox.md) when you need the startup sequence, directory map, tmux sessions, services, or lifecycle details. Read [references/tools.md](references/tools.md) when you need MCP tool inputs, Git or provider access, CLI fallbacks, or publication operations.

Follow the user's task and its authorization for writes, comments, reviews, PRs, or termination. The sandbox context does not itself request any of those actions.
