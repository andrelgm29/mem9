import type { MemoryBackend } from "./backend.js";
import type {
  Memory,
  SearchResult,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchInput,
  MnemoConfig,
} from "./types.js";

const SPACE_ID = "default";
const MAX_CONTENT = 50_000;
const RRF_K = 60;

interface TiDBResponse {
  types?: { name: string }[];
  rows?: unknown[][];
}

export class DirectBackend implements MemoryBackend {
  private url: string;
  private auth: string;
  private db: string;
  private dims: number;
  private autoEmbedModel: string | undefined;
  private ftsAvailable = false;
  private vectorLegEnabled = true;
  private schemaReady: Promise<void>;

  constructor(cfg: MnemoConfig) {
    this.url = `https://http-${cfg.dbHost}/v1beta/sql`;
    this.auth = "Basic " + btoa(`${cfg.dbUser}:${cfg.dbPass}`);
    this.db = cfg.dbName;
    this.dims = cfg.autoEmbedModel ? cfg.autoEmbedDims : cfg.embedDims;
    this.autoEmbedModel = cfg.autoEmbedModel;
    this.schemaReady = this.ensureSchema();
  }

  private escape(val: unknown): string {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number") return String(val);
    if (typeof val === "boolean") return val ? "1" : "0";
    const s = String(val)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\0/g, "\\0")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\x1a/g, "\\Z");
    return `'${s}'`;
  }

  private interpolate(query: string, params?: unknown[]): string {
    if (!params || params.length === 0) return query;
    let i = 0;
    return query.replace(/\?/g, () => this.escape(params[i++]));
  }

  private async sql(query: string, params?: unknown[]): Promise<TiDBResponse> {
    const body: Record<string, unknown> = { database: this.db, query: this.interpolate(query, params) };

    const resp = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: this.auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`TiDB HTTP API ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<TiDBResponse>;
  }

  private async ensureSchema(): Promise<void> {
    try {
      const embeddingCol = this.autoEmbedModel
        ? `embedding VECTOR(${this.dims}) GENERATED ALWAYS AS (EMBED_TEXT('${this.autoEmbedModel}', content)) STORED`
        : `embedding VECTOR(${this.dims}) NULL`;

      await this.sql(`CREATE TABLE IF NOT EXISTS memories (
        id          VARCHAR(36)       PRIMARY KEY,
        space_id    VARCHAR(36)       NOT NULL,
        content     TEXT              NOT NULL,
        key_name    VARCHAR(255),
        source      VARCHAR(100),
        tags        JSON,
        metadata    JSON,
        ${embeddingCol},
        version     INT               DEFAULT 1,
        updated_by  VARCHAR(100),
        created_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE INDEX idx_key    (space_id, key_name),
        INDEX idx_space         (space_id),
        INDEX idx_source        (space_id, source),
        INDEX idx_updated       (space_id, updated_at)
      )`);

      if (this.autoEmbedModel) {
        this.vectorLegEnabled = await this.migrateGeneratedEmbedding();
      }

      try {
        await this.sql(`ALTER TABLE memories ADD VECTOR INDEX idx_cosine ((VEC_COSINE_DISTANCE(embedding)))`);
      } catch { /* already exists or TiFlash unavailable */ }

      try {
        await this.sql(`ALTER TABLE memories ADD FULLTEXT INDEX idx_fts_content (content) WITH PARSER MULTILINGUAL ADD_COLUMNAR_REPLICA_ON_DEMAND`);
      } catch { /* already exists or unsupported */ }

      this.ftsAvailable = await this.probeFTS();
    } catch {
      // Table may already exist — continue.
    }
  }

  private async migrateGeneratedEmbedding(): Promise<boolean> {
    try {
      const result = await this.sql(
        `SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'memories' AND COLUMN_NAME = 'embedding'`
      );
      const cols = result.types?.map((c) => c.name) ?? [];
      const rows = (result.rows ?? []).map((row) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((col, i) => (obj[col] = (row as unknown[])[i]));
        return obj;
      });

      if (rows.length === 0) {
        console.info("[mnemo] adding generated embedding column — may take a moment for existing rows");
        try {
          await this.sql(
            `ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding VECTOR(${this.dims})
             GENERATED ALWAYS AS (EMBED_TEXT('${this.autoEmbedModel}', content)) STORED`
          );
        } catch (e) {
          console.warn("[mnemo] failed to add generated embedding column:", e);
        }
        return true;
      }

      const extra = String(rows[0]?.EXTRA ?? "").toUpperCase();
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
    } catch {
      return true;
    }
  }

  private async probeFTS(): Promise<boolean> {
    const maxAttempts = 5;
    const retryDelayMs = 5000;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.sql(`SELECT fts_match_word('probe', content) FROM memories LIMIT 0`);
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

  private rowsToMemories(data: TiDBResponse): Memory[] {
    const cols = data.types?.map((c) => c.name) ?? [];
    return (data.rows ?? []).map((row) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => (obj[col] = row[i]));
      let tags = obj.tags;
      if (typeof tags === "string") {
        try { tags = JSON.parse(tags); } catch { tags = []; }
      }
      let metadata = obj.metadata;
      if (typeof metadata === "string") {
        try { metadata = JSON.parse(metadata); } catch { metadata = null; }
      }
      return {
        id: obj.id as string,
        content: obj.content as string,
        key: (obj.key_name as string) || null,
        source: (obj.source as string) || null,
        tags: (tags as string[]) || null,
        metadata: (metadata as Record<string, unknown>) || null,
        version: obj.version as number,
        updated_by: (obj.updated_by as string) || null,
        created_at: String(obj.created_at),
        updated_at: String(obj.updated_at),
      };
    });
  }

  private rowsToMemoriesWithScore(data: TiDBResponse, scoreCol: string): Array<Memory & { _score: number }> {
    const cols = data.types?.map((c) => c.name) ?? [];
    return (data.rows ?? []).map((row) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => (obj[col] = row[i]));
      let tags = obj.tags;
      if (typeof tags === "string") {
        try { tags = JSON.parse(tags); } catch { tags = []; }
      }
      let metadata = obj.metadata;
      if (typeof metadata === "string") {
        try { metadata = JSON.parse(metadata); } catch { metadata = null; }
      }
      return {
        id: obj.id as string,
        content: obj.content as string,
        key: (obj.key_name as string) || null,
        source: (obj.source as string) || null,
        tags: (tags as string[]) || null,
        metadata: (metadata as Record<string, unknown>) || null,
        version: obj.version as number,
        updated_by: (obj.updated_by as string) || null,
        created_at: String(obj.created_at),
        updated_at: String(obj.updated_at),
        _score: Number(obj[scoreCol] ?? 0),
      };
    });
  }

  async store(input: CreateMemoryInput): Promise<Memory> {
    await this.schemaReady;
    if (!input.content || input.content.length > MAX_CONTENT) {
      throw new Error(`content is required and must be <= ${MAX_CONTENT} chars`);
    }

    const id = crypto.randomUUID();
    const tags = JSON.stringify(input.tags ?? []);
    const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

    await this.sql(
      `INSERT INTO memories (id, space_id, content, key_name, source, tags, metadata, version, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         content = VALUES(content), source = VALUES(source), tags = VALUES(tags),
         metadata = VALUES(metadata), version = version + 1, updated_by = VALUES(updated_by),
         updated_at = NOW()`,
      [id, SPACE_ID, input.content, input.key ?? null, input.source ?? null, tags, metadata, input.source ?? null],
    );

    if (input.key) {
      const result = await this.sql(
        "SELECT * FROM memories WHERE space_id = ? AND key_name = ?",
        [SPACE_ID, input.key],
      );
      const mems = this.rowsToMemories(result);
      if (mems.length > 0) return mems[0];
    }

    const result = await this.sql("SELECT * FROM memories WHERE id = ?", [id]);
    const mems = this.rowsToMemories(result);
    return mems[0] ?? { id, content: input.content, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  }

  async search(input: SearchInput): Promise<SearchResult> {
    await this.schemaReady;
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);

    if (input.q && (this.autoEmbedModel)) {
      return this.autoHybridSearch(input.q, input, limit, offset);
    }
    return this.keywordSearch(input, limit, offset);
  }

  private buildFilter(input: SearchInput): { conds: string[]; params: unknown[] } {
    const conds: string[] = ["space_id = ?"];
    const params: unknown[] = [SPACE_ID];

    if (input.source) { conds.push("source = ?"); params.push(input.source); }
    if (input.key) { conds.push("key_name = ?"); params.push(input.key); }
    if (input.tags) {
      for (const tag of input.tags.split(",").map((t) => t.trim()).filter(Boolean)) {
        conds.push("JSON_CONTAINS(tags, ?)");
        params.push(JSON.stringify(tag));
      }
    }
    return { conds, params };
  }

  private async keywordSearch(input: SearchInput, limit: number, offset: number): Promise<SearchResult> {
    const { conds, params } = this.buildFilter(input);

    if (input.q && this.ftsAvailable) {
      return this.ftsOnlySearch(input.q, conds, params, limit, offset);
    }

    if (input.q) {
      conds.push("content LIKE CONCAT('%', ?, '%')");
      params.push(input.q);
    }

    const where = conds.join(" AND ");
    const countResult = await this.sql(`SELECT COUNT(*) as cnt FROM memories WHERE ${where}`, params);
    const total = Number((countResult.rows?.[0]?.[0]) ?? 0);

    const dataResult = await this.sql(
      `SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return { memories: this.rowsToMemories(dataResult), total, limit, offset };
  }

  private async ftsOnlySearch(
    q: string,
    filterConds: string[],
    filterParams: unknown[],
    limit: number,
    offset: number
  ): Promise<SearchResult> {
    try {
      const fetchLimit = limit * 3;
      const ftsResult = await this.sql(
        `SELECT *, fts_match_word(?, content) AS fts_score
         FROM memories
         WHERE ${filterConds.join(" AND ")} AND fts_match_word(?, content)
         ORDER BY fts_match_word(?, content) DESC
         LIMIT ?`,
        [q, ...filterParams, q, q, fetchLimit],
      );
      const rows = this.rowsToMemoriesWithScore(ftsResult, "fts_score");
      const page = rows.slice(offset, offset + limit);
      return {
        memories: page.map(({ _score, ...m }) => ({ ...m, score: _score })),
        total: rows.length,
        limit,
        offset,
      };
    } catch {
      console.warn("[mnemo] keyword leg skipped (FTS error); using LIKE fallback");
      const conds = [...filterConds, "content LIKE CONCAT('%', ?, '%')"];
      const dataResult = await this.sql(
        `SELECT * FROM memories WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        [...filterParams, q, limit, offset],
      );
      const memories = this.rowsToMemories(dataResult);
      return { memories, total: memories.length, limit, offset };
    }
  }

  private async autoHybridSearch(
    q: string,
    input: SearchInput,
    limit: number,
    offset: number
  ): Promise<SearchResult> {
    const { conds: filterConds, params: filterParams } = this.buildFilter(input);
    const fetchLimit = limit * 3;

    type ScoredRow = { id: string; mem: Memory; score: number };
    const byId = new Map<string, ScoredRow>();

    let vecFailed = false;
    if (this.vectorLegEnabled) {
      try {
        const vecResult = await this.sql(
          `SELECT *, VEC_EMBED_COSINE_DISTANCE(embedding, ?) AS distance
           FROM memories
           WHERE ${filterConds.join(" AND ")} AND embedding IS NOT NULL
           ORDER BY VEC_EMBED_COSINE_DISTANCE(embedding, ?)
           LIMIT ?`,
          [q, ...filterParams, q, fetchLimit],
        );
        const vecRows = this.rowsToMemoriesWithScore(vecResult, "distance");
        for (let rank = 0; rank < vecRows.length; rank++) {
          const { _score, ...mem } = vecRows[rank];
          byId.set(mem.id, { id: mem.id, mem, score: 1 / (RRF_K + rank + 1) });
        }
      } catch {
        console.warn("[mnemo] vector leg skipped");
        vecFailed = true;
      }
    }

    let kwFailed = false;
    if (this.ftsAvailable) {
      try {
        const ftsResult = await this.sql(
          `SELECT *, fts_match_word(?, content) AS fts_score
           FROM memories
           WHERE ${filterConds.join(" AND ")} AND fts_match_word(?, content)
           ORDER BY fts_match_word(?, content) DESC
           LIMIT ?`,
          [q, ...filterParams, q, q, fetchLimit],
        );
        const ftsRows = this.rowsToMemoriesWithScore(ftsResult, "fts_score");
        for (let rank = 0; rank < ftsRows.length; rank++) {
          const { _score, ...mem } = ftsRows[rank];
          const existing = byId.get(mem.id);
          const add = 1 / (RRF_K + rank + 1);
          byId.set(mem.id, { id: mem.id, mem: existing?.mem ?? mem, score: (existing?.score ?? 0) + add });
        }
      } catch {
        console.warn("[mnemo] keyword leg skipped (FTS error)");
        kwFailed = true;
      }
    } else {
      try {
        const likeResult = await this.sql(
          `SELECT * FROM memories WHERE ${filterConds.join(" AND ")} AND content LIKE CONCAT('%', ?, '%') ORDER BY updated_at DESC LIMIT ?`,
          [...filterParams, q, fetchLimit],
        );
        const likeRows = this.rowsToMemories(likeResult);
        for (let rank = 0; rank < likeRows.length; rank++) {
          const mem = likeRows[rank];
          const existing = byId.get(mem.id);
          const add = 1 / (RRF_K + rank + 1);
          byId.set(mem.id, { id: mem.id, mem: existing?.mem ?? mem, score: (existing?.score ?? 0) + add });
        }
      } catch {
        console.warn("[mnemo] keyword leg skipped (LIKE error)");
        kwFailed = true;
      }
    }

    if (vecFailed && kwFailed) {
      console.error("[mnemo] both search legs failed");
      return { memories: [], total: 0, limit, offset };
    }

    const sorted = Array.from(byId.values()).sort((a, b) => b.score - a.score);
    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);

    return {
      memories: page.map(({ mem, score }) => ({ ...mem, score })),
      total,
      limit,
      offset,
    };
  }

  async get(id: string): Promise<Memory | null> {
    await this.schemaReady;
    const result = await this.sql(
      "SELECT * FROM memories WHERE id = ? AND space_id = ?", [id, SPACE_ID],
    );
    const mems = this.rowsToMemories(result);
    return mems[0] ?? null;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    await this.schemaReady;
    const existing = await this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (input.content !== undefined) {
      if (input.content.length > MAX_CONTENT) throw new Error(`content must be <= ${MAX_CONTENT} chars`);
      sets.push("content = ?"); values.push(input.content);
    }
    if (input.key !== undefined) { sets.push("key_name = ?"); values.push(input.key); }
    if (input.source !== undefined) { sets.push("source = ?"); values.push(input.source); }
    if (input.tags !== undefined) { sets.push("tags = ?"); values.push(JSON.stringify(input.tags)); }
    if (input.metadata !== undefined) { sets.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

    if (sets.length === 0) return existing;
    sets.push("version = version + 1");

    await this.sql(
      `UPDATE memories SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`,
      [...values, id, SPACE_ID],
    );

    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    await this.schemaReady;
    const existing = await this.get(id);
    if (!existing) return false;
    await this.sql("DELETE FROM memories WHERE id = ? AND space_id = ?", [id, SPACE_ID]);
    return true;
  }

  async listRecent(limit: number): Promise<Memory[]> {
    await this.schemaReady;
    const result = await this.sql(
      "SELECT * FROM memories WHERE space_id = ? ORDER BY updated_at DESC LIMIT ?",
      [SPACE_ID, limit],
    );
    return this.rowsToMemories(result);
  }
}
