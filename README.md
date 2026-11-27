# CLI Agent Chat

A browser chat interface for Codex and Claude CLI agents. Run it locally or add
it to a Coder workspace as an owner-only app that opens in a popup window.

Includes streaming replies, saved and resumable conversations, model selection,
Markdown rendering, text and image attachments, and interactive questions through
a bundled MCP tool.

## Run locally

Install Node.js 22 or newer and the `codex` and/or `claude` CLI. Authenticate the
CLI you want to use before starting the server; the app inherits its existing
configuration and environment.

```sh
git clone https://github.com/wyattfry/cli-agent-chat.git
cd cli-agent-chat
npm ci
npm start
```

Open <http://localhost:3000>. To change the port, use `PORT=38182 npm start`.
New conversations start in your home directory. Conversation data and attachments
are saved in `.sessions/` beside the server; this directory is excluded from Git.

The server listens on loopback. Anyone who can access the app can run the agent
CLIs with your account's permissions, so keep it behind authenticated access.

## Add to a Coder template

Add this module to your Linux workspace template. The agent needs Node.js, npm,
and authenticated agent CLIs on its `PATH`. Coder wildcard app routing must be
configured because the app uses a subdomain.

```hcl
module "cli_agent_chat" {
  source   = "git::https://github.com/wyattfry/cli-agent-chat.git?ref=main"
  agent_id = coder_agent.main.id
}
```

Replace `coder_agent.main.id` with your agent reference. For reproducible
templates, replace `ref=main` with a commit SHA.

The module lives at the repository root, not in a subdirectory, because Coder
caches a remote module by saving only that module's directory. A module in
`coder/` would lose the app files it reads from the parent directory.

The app opens in a new popup window without navigation controls, using
`open_in = "slim-window"`, like Coder's Terminal app. Set `open_in = "tab"` on
the module to open a regular tab. Only the workspace owner can access the app.
The default port is `38182`; set `port` on the module to change it. The slug is
`agent-chat`, so it must be unique within the workspace.

The startup script installs the app under `$HOME/.local/share/cli-agent-chat`,
keeps conversations there across restarts, and writes `server.log` there.

## Development

```sh
npm ci
npm test
```

Tests use dummy CLI executables and temporary directories; they require no
provider credentials or paid API calls.

Extracted from the CLI Agent Chat Coder workspace app, with portable home-directory
handling and a reusable Coder module. This repository contains the app and its
tests, with a fresh Git history.
