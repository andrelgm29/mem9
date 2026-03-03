import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./types.js";
import { DirectBackend } from "./direct-backend.js";
import { ServerBackend } from "./server-backend.js";
import { buildTools } from "./tools.js";
import { buildHooks } from "./hooks.js";

/**
 * mnemo-opencode — AI agent memory plugin for OpenCode.
 *
 * Mode detection (same as openclaw-plugin):
 *   - MNEMO_DB_HOST set → Direct mode (TiDB Serverless HTTP Data API)
 *   - MNEMO_API_URL set → Server mode (mnemo-server REST API)
 *   - Neither → Plugin disabled (no-op hooks, no tools)
 */
const mnemoPlugin: Plugin = async (_input) => {
  const cfg = loadConfig();

  if (cfg.mode === "none") {
    console.warn(
      "[mnemo] No mode configured. Set MNEMO_DB_HOST (direct) or MNEMO_API_URL (server). Plugin disabled."
    );
    return {};
  }

  let backend;

  if (cfg.mode === "direct") {
    if (!cfg.dbUser || !cfg.dbPass) {
      console.warn(
        "[mnemo] Direct mode requires MNEMO_DB_USER and MNEMO_DB_PASS. Plugin disabled."
      );
      return {};
    }
    if (cfg.autoEmbedModel) {
      console.info(`[mnemo] Direct mode (auto-embed hybrid: ${cfg.autoEmbedModel})`);
    } else {
      console.info("[mnemo] Direct mode (keyword search: FTS preferred, LIKE fallback)");
    }
    backend = new DirectBackend(cfg);
  } else {
    if (!cfg.apiToken) {
      console.warn(
        "[mnemo] Server mode requires MNEMO_API_TOKEN. Plugin disabled."
      );
      return {};
    }
    console.info("[mnemo] Server mode (mnemo-server REST API)");
    backend = new ServerBackend(cfg);
  }

  const tools = buildTools(backend);
  const hooks = buildHooks(backend);

  return {
    tool: tools,
    ...hooks,
  };
};

export default mnemoPlugin;
