/** Env-based configuration for mnemo plugin. */
export interface MnemoConfig {
  mode: "direct" | "server" | "none";

  // Direct mode (TiDB Serverless HTTP Data API)
  dbHost?: string;
  dbUser?: string;
  dbPass?: string;
  dbName: string;

  // Server mode (mnemo-server REST API)
  apiUrl?: string;
  apiToken?: string;

  // Embedding provider (optional — omit for keyword-only search)
  embedApiKey?: string;
  embedBaseUrl?: string;
  embedModel: string;
  embedDims: number;

  // TiDB auto-embedding (direct mode only — no external API key required)
  autoEmbedModel?: string;
  autoEmbedDims: number;
}

export interface Memory {
  id: string;
  content: string;
  key?: string | null;
  source?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  version?: number;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  score?: number;
}

export interface SearchResult {
  memories: Memory[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateMemoryInput {
  content: string;
  key?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  content?: string;
  key?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SearchInput {
  q?: string;
  tags?: string;
  source?: string;
  key?: string;
  limit?: number;
  offset?: number;
}

/** Load config from env vars. */
export function loadConfig(): MnemoConfig {
  const dbHost = process.env.MNEMO_DB_HOST ?? "";
  const apiUrl = process.env.MNEMO_API_URL ?? "";

  let mode: MnemoConfig["mode"] = "none";
  if (dbHost) mode = "direct";
  else if (apiUrl) mode = "server";

  return {
    mode,
    dbHost: dbHost || undefined,
    dbUser: process.env.MNEMO_DB_USER ?? undefined,
    dbPass: process.env.MNEMO_DB_PASS ?? undefined,
    dbName: process.env.MNEMO_DB_NAME ?? "mnemos",
    apiUrl: apiUrl || undefined,
    apiToken: process.env.MNEMO_API_TOKEN ?? undefined,
    embedApiKey: process.env.MNEMO_EMBED_API_KEY ?? undefined,
    embedBaseUrl: process.env.MNEMO_EMBED_BASE_URL ?? undefined,
    embedModel: process.env.MNEMO_EMBED_MODEL ?? "text-embedding-3-small",
    embedDims: parseInt(process.env.MNEMO_EMBED_DIMS ?? "1536", 10) || 1536,
    autoEmbedModel: process.env.MNEMO_AUTO_EMBED_MODEL || undefined,
    autoEmbedDims: parseInt(process.env.MNEMO_AUTO_EMBED_DIMS ?? "1024", 10) || 1024,
  };
}
