terraform {
  required_version = ">= 1.0"
  required_providers {
    coder = {
      source  = "coder/coder"
      version = ">= 2.13"
    }
  }
}

variable "agent_id" {
  type        = string
  description = "Coder agent that has Node.js, npm, and the agent CLIs installed."
}

variable "port" {
  type        = number
  default     = 38182
  description = "Loopback port for the chat server."
  validation {
    condition     = var.port >= 1024 && var.port <= 65535 && floor(var.port) == var.port
    error_message = "Use an integer port between 1024 and 65535."
  }
}

variable "open_in" {
  type        = string
  default     = "slim-window"
  description = "Open in a popup window without navigation controls, or a browser tab."
  validation {
    condition     = contains(["slim-window", "tab"], var.open_in)
    error_message = "Choose slim-window or tab."
  }
}

data "coder_workspace" "me" {}

resource "coder_script" "chat" {
  agent_id           = var.agent_id
  display_name       = "CLI Agent Chat"
  icon               = "/icon/tasks.svg"
  run_on_start       = true
  start_blocks_login = false
  script = templatefile("${path.module}/coder/run.sh", {
    PORT                = var.port
    SERVER_JS_BASE64    = filebase64("${path.module}/server.js")
    INDEX_HTML_BASE64   = filebase64("${path.module}/index.html")
    MCP_JS_BASE64       = filebase64("${path.module}/mcp-ask-user.js")
    PACKAGE_JSON_BASE64 = filebase64("${path.module}/package.json")
    PACKAGE_LOCK_BASE64 = filebase64("${path.module}/package-lock.json")
  })
}

resource "coder_app" "chat" {
  count        = data.coder_workspace.me.start_count > 0 ? 1 : 0
  agent_id     = var.agent_id
  slug         = "agent-chat"
  display_name = "CLI Agent Chat"
  icon         = "/icon/tasks.svg"
  url          = "http://localhost:${var.port}"
  subdomain    = true
  share        = "owner"
  open_in      = var.open_in
  order        = 11
  tooltip      = "Chat with Codex or Claude in this workspace."

  healthcheck {
    url       = "http://localhost:${var.port}/"
    interval  = 10
    threshold = 6
  }
}

output "app_id" {
  description = "App ID while the workspace is running, otherwise null."
  value       = try(coder_app.chat[0].id, null)
}
