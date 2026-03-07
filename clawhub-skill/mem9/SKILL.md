---
name: mem9
version: 0.1.0
description: "Cloud-persistent memory for AI agents — cross-session recall, multi-agent sharing, hybrid vector + keyword search. Install the mnemo plugin to give your agent a brain that never forgets."
author: qiffang
keywords: [memory, agent-memory, persistent-memory, vector-search, hybrid-search, cloud-memory, multi-agent, cross-session, openclaw, ai-agent, mem9, mnemo]
metadata:
  openclaw:
    emoji: "\U0001F9E0"
---

# mem9 — Persistent Memory for AI Agents

> Coming soon. Full skill with auto-install instructions will be published shortly.

Give your OpenClaw agent persistent cloud memory. Memories survive sessions, devices, and agent restarts.

## What You Get

- **Cross-session recall** — Agent remembers what it learned yesterday
- **Multi-agent sharing** — Claude Code, OpenCode, and OpenClaw share one memory pool
- **Hybrid search** — Vector similarity + keyword search, merged with RRF ranking
- **Stateless plugins** — All state lives in mnemo-server, agents stay disposable

## Quick Preview

```bash
# Install the memory plugin
npm install mnemo-openclaw
```

```json
{
  "plugins": {
    "slots": { "memory": "mnemo" },
    "entries": {
      "mnemo": {
        "enabled": true,
        "config": {
          "apiUrl": "http://your-server:8080",
          "apiToken": "mnemo_your_token"
        }
      }
    }
  }
}
```

## Links

- **GitHub**: [github.com/qiffang/mnemos](https://github.com/qiffang/mnemos)
- **Server**: [mnemo-server](https://github.com/qiffang/mnemos/tree/main/server)

---

*Full installation skill coming soon. Star this to get notified.*
