import type { Connection } from "@tidbcloud/serverless";

export interface SchemaResult {
  ftsAvailable: boolean;
  vectorLegEnabled: boolean;
}

export async function initSchema(
  conn: Connection,
  dims: number = 1536,
  autoEmbedModel?: string
): Promise<SchemaResult> {
  const embeddingCol = autoEmbedModel
    ? `embedding VECTOR(${dims}) GENERATED ALWAYS AS (EMBED_TEXT("${autoEmbedModel}", content)) STORED,`
    : `embedding VECTOR(${dims}) NULL,`;

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS memories (
      id          VARCHAR(36)       PRIMARY KEY,
      space_id    VARCHAR(36)       NOT NULL,
      content     TEXT              NOT NULL,
      key_name    VARCHAR(255),
      source      VARCHAR(100),
      tags        JSON,
      metadata    JSON,
      ${embeddingCol}
      version     INT               DEFAULT 1,
      updated_by  VARCHAR(100),
      created_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_key    (space_id, key_name),
      INDEX idx_space         (space_id),
      INDEX idx_source        (space_id, source),
      INDEX idx_updated       (space_id, updated_at)
    )
  `);

  let vectorLegEnabled = true;
  if (autoEmbedModel) {
    vectorLegEnabled = await migrateGeneratedEmbedding(conn, autoEmbedModel, dims);
  }

  try {
    await conn.execute(
      `ALTER TABLE memories ADD VECTOR INDEX idx_cosine ((VEC_COSINE_DISTANCE(embedding)))`
    );
  } catch {
    // Already exists or TiFlash unavailable — no-op.
  }

  try {
    await conn.execute(
      `ALTER TABLE memories ADD FULLTEXT INDEX idx_fts_content (content) WITH PARSER MULTILINGUAL ADD_COLUMNAR_REPLICA_ON_DEMAND`
    );
  } catch {
    // Already exists or unsupported — no-op.
  }

  const ftsAvailable = await probeFTS(conn);
  return { ftsAvailable, vectorLegEnabled };
}

async function migrateGeneratedEmbedding(
  conn: Connection,
  model: string,
  dims: number
): Promise<boolean> {
  const rows = (await conn.execute(
    `SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memories' AND COLUMN_NAME = 'embedding'`
  )) as unknown as { EXTRA: string }[];

  if (rows.length === 0) {
    console.info("[mnemo] adding generated embedding column — may take a moment for existing rows");
    try {
      await conn.execute(
        `ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding VECTOR(${dims})
         GENERATED ALWAYS AS (EMBED_TEXT("${model}", content)) STORED`
      );
    } catch (e) {
      console.warn("[mnemo] failed to add generated embedding column:", e);
    }
    return true;
  }

  const extra = (rows[0]?.EXTRA ?? "").toUpperCase();
  if (extra.includes("GENERATED") || extra.includes("DEFAULT_GENERATED")) {
    return true;
  }

  console.warn(
    "[mnemo] WARN: embedding column exists as a plain (non-generated) column. " +
      "Auto-embed vector search is disabled until you migrate:\n" +
      "  ALTER TABLE memories DROP COLUMN embedding;\n" +
      "Then restart — the generated column will be re-created automatically."
  );
  return false;
}

async function probeFTS(conn: Connection): Promise<boolean> {
  const maxAttempts = 5;
  const retryDelayMs = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await conn.execute(`SELECT fts_match_word('probe', content) FROM memories LIMIT 0`);
      return true;
    } catch (e: unknown) {
      const msg = String(e).toLowerCase();
      const isProvisioning = msg.includes("columnar") || msg.includes("tiflash");
      if (isProvisioning) {
        console.warn(`[mnemo] FTS index provisioning in progress; will retry (attempt ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        console.warn("[mnemo] FTS not available after retries; keyword searches will fall back to LIKE");
        return false;
      }
      console.warn("[mnemo] FTS not supported on this cluster; keyword searches will fall back to LIKE");
      return false;
    }
  }
  return false;
}
