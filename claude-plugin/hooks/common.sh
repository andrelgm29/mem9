#!/usr/bin/env bash
# common.sh — Shared helpers for mnemo hooks.
# Sourced by all hook scripts.
#
# Mode detection:
#   MNEMO_DB_HOST set → direct mode (TiDB Serverless HTTP Data API)
#   MNEMO_API_URL set → server mode (mnemo-server REST API)

set -euo pipefail

MNEMO_SPACE_ID="default"

# Detect which mode we're in.
mnemo_mode() {
  if [[ -n "${MNEMO_DB_HOST:-}" ]]; then
    echo "direct"
  elif [[ -n "${MNEMO_API_URL:-}" ]]; then
    echo "server"
  else
    echo "none"
  fi
}

# Validate that at least one mode is configured.
mnemo_check_env() {
  local mode
  mode=$(mnemo_mode)
  if [[ "$mode" == "none" ]]; then
    echo '{"error":"Neither MNEMO_DB_HOST (direct) nor MNEMO_API_URL (server) is set"}' >&2
    return 1
  fi
  if [[ "$mode" == "direct" ]]; then
    if [[ -z "${MNEMO_DB_USER:-}" || -z "${MNEMO_DB_PASS:-}" ]]; then
      echo '{"error":"Direct mode requires MNEMO_DB_HOST, MNEMO_DB_USER, MNEMO_DB_PASS"}' >&2
      return 1
    fi
  fi
  if [[ "$mode" == "server" ]]; then
    if [[ -z "${MNEMO_API_TOKEN:-}" ]]; then
      echo '{"error":"Server mode requires MNEMO_API_URL and MNEMO_API_TOKEN"}' >&2
      return 1
    fi
  fi
}

# ─── Server mode helpers ────────────────────────────────────────────

# mnemo_server_get <path> — GET request to mnemo-server.
mnemo_server_get() {
  local path="$1"
  curl -sf --max-time 8 \
    -H "Authorization: Bearer ${MNEMO_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${MNEMO_API_URL}${path}"
}

# mnemo_server_post <path> <json_body> — POST request to mnemo-server.
mnemo_server_post() {
  local path="$1"
  local body="$2"
  curl -sf --max-time 8 \
    -H "Authorization: Bearer ${MNEMO_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${body}" \
    "${MNEMO_API_URL}${path}"
}

# ─── Direct mode helpers ────────────────────────────────────────────

# mnemo_sql <sql> — Execute SQL against TiDB HTTP Data API.
# The SQL must have values inline (no parameterized queries).
mnemo_sql() {
  local sql="$1"
  local db="${MNEMO_DB_NAME:-mnemos}"
  local url="https://http-${MNEMO_DB_HOST}/v1beta/sql"

  local body
  body=$(MNEMO_DB="$db" MNEMO_Q="$sql" python3 -c "
import json, os
print(json.dumps({'database': os.environ['MNEMO_DB'], 'query': os.environ['MNEMO_Q']}))
" 2>/dev/null) || return 1

  curl -sf --max-time 10 \
    -u "${MNEMO_DB_USER}:${MNEMO_DB_PASS}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$url"
}

# mnemo_direct_init — Auto-create table, add FTS index, add generated embedding column (direct mode).
mnemo_direct_init() {
  local dims="${MNEMO_EMBED_DIMS:-1536}"
  local db="${MNEMO_DB_NAME:-mnemos}"

  if [[ -n "${MNEMO_AUTO_EMBED_MODEL:-}" ]]; then
    local auto_dims="${MNEMO_AUTO_EMBED_DIMS:-1024}"
    mnemo_sql "CREATE TABLE IF NOT EXISTS ${db}.memories (
      id          VARCHAR(36)       PRIMARY KEY,
      space_id    VARCHAR(36)       NOT NULL,
      content     TEXT              NOT NULL,
      key_name    VARCHAR(255),
      source      VARCHAR(100),
      tags        JSON,
      metadata    JSON,
      embedding   VECTOR(${auto_dims}) GENERATED ALWAYS AS (EMBED_TEXT('${MNEMO_AUTO_EMBED_MODEL}', content)) STORED,
      version     INT               DEFAULT 1,
      updated_by  VARCHAR(100),
      created_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_key    (space_id, key_name),
      INDEX idx_space         (space_id),
      INDEX idx_source        (space_id, source),
      INDEX idx_updated       (space_id, updated_at)
    )" >/dev/null 2>&1 || true
  else
    mnemo_sql "CREATE TABLE IF NOT EXISTS ${db}.memories (
      id          VARCHAR(36)       PRIMARY KEY,
      space_id    VARCHAR(36)       NOT NULL,
      content     TEXT              NOT NULL,
      key_name    VARCHAR(255),
      source      VARCHAR(100),
      tags        JSON,
      metadata    JSON,
      embedding   VECTOR(${dims})   NULL,
      version     INT               DEFAULT 1,
      updated_by  VARCHAR(100),
      created_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_key    (space_id, key_name),
      INDEX idx_space         (space_id),
      INDEX idx_source        (space_id, source),
      INDEX idx_updated       (space_id, updated_at)
    )" >/dev/null 2>&1 || true
  fi

  mnemo_sql "ALTER TABLE ${db}.memories ADD VECTOR INDEX idx_cosine ((VEC_COSINE_DISTANCE(embedding)))" >/dev/null 2>&1 || true

  mnemo_sql "ALTER TABLE ${db}.memories ADD FULLTEXT INDEX idx_fts_content (content) WITH PARSER MULTILINGUAL ADD_COLUMNAR_REPLICA_ON_DEMAND" >/dev/null 2>&1 || true

  if [[ -n "${MNEMO_AUTO_EMBED_MODEL:-}" ]]; then
    local auto_dims="${MNEMO_AUTO_EMBED_DIMS:-1024}"
    local col_check
    col_check=$(mnemo_sql "SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='${db}' AND TABLE_NAME='memories' AND COLUMN_NAME='embedding'" 2>/dev/null || echo "")
    local extra
    extra=$(echo "$col_check" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    rows = data.get('rows', [])
    print(rows[0][0] if rows else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

    if [[ -z "$extra" ]]; then
      echo "[mnemo] adding generated embedding column — may take a moment for existing rows" >&2
      mnemo_sql "ALTER TABLE ${db}.memories ADD COLUMN IF NOT EXISTS embedding VECTOR(${auto_dims}) GENERATED ALWAYS AS (EMBED_TEXT('${MNEMO_AUTO_EMBED_MODEL}', content)) STORED" >/dev/null 2>&1 || true
    else
      local upper_extra
      upper_extra=$(echo "$extra" | tr '[:lower:]' '[:upper:]')
      if [[ "$upper_extra" != *"GENERATED"* && "$upper_extra" != *"DEFAULT_GENERATED"* ]]; then
        echo "[mnemo] WARN: embedding column exists as a plain (non-generated) column. Auto-embed vector search is disabled until you migrate:" >&2
        echo "  ALTER TABLE ${db}.memories DROP COLUMN embedding;" >&2
        echo "Then restart — the generated column will be re-created automatically." >&2
        export MNEMO_VECTOR_LEG_DISABLED=1
      fi
    fi
  fi

  local fts_probe_result
  fts_probe_result=$(mnemo_sql "SELECT fts_match_word('probe', content) FROM ${db}.memories LIMIT 0" 2>&1 || echo "ERROR")
  local max_fts_retries=5
  local fts_retry=1
  while [[ "$fts_probe_result" == *"ERROR"* ]] && [[ $fts_retry -lt $max_fts_retries ]]; do
    local lower_result
    lower_result=$(echo "$fts_probe_result" | tr '[:upper:]' '[:lower:]')
    if [[ "$lower_result" != *"columnar"* && "$lower_result" != *"tiflash"* ]]; then
      break
    fi
    echo "[mnemo] FTS index provisioning in progress; will retry (attempt ${fts_retry}/${max_fts_retries})" >&2
    sleep 5
    fts_retry=$((fts_retry + 1))
    fts_probe_result=$(mnemo_sql "SELECT fts_match_word('probe', content) FROM ${db}.memories LIMIT 0" 2>&1 || echo "ERROR")
  done

  if [[ "$fts_probe_result" == *"ERROR"* ]]; then
    local lower_result
    lower_result=$(echo "$fts_probe_result" | tr '[:upper:]' '[:lower:]')
    if [[ "$lower_result" == *"columnar"* || "$lower_result" == *"tiflash"* ]]; then
      echo "[mnemo] FTS not available after retries; keyword searches will fall back to LIKE" >&2
    else
      echo "[mnemo] FTS not supported on this cluster; keyword searches will fall back to LIKE" >&2
    fi
    export MNEMO_FTS_AVAILABLE=0
  else
    export MNEMO_FTS_AVAILABLE=1
  fi
}

# ─── Mode-agnostic helpers ──────────────────────────────────────────

# mnemo_get_memories [limit] — Fetch recent memories (works in both modes).
mnemo_get_memories() {
  local limit="${1:-20}"
  local mode
  mode=$(mnemo_mode)

  if [[ "$mode" == "server" ]]; then
    mnemo_server_get "/api/memories?limit=${limit}"
  elif [[ "$mode" == "direct" ]]; then
    mnemo_direct_init
    local result
    result=$(mnemo_sql "SELECT id, content, key_name, source, tags, version, updated_by, created_at, updated_at FROM ${MNEMO_DB_NAME:-mnemos}.memories WHERE space_id = '${MNEMO_SPACE_ID}' ORDER BY updated_at DESC LIMIT ${limit}" 2>/dev/null || echo "")
    if [[ -z "$result" ]]; then
      echo '{"memories":[],"total":0}'
      return
    fi
    # Transform TiDB HTTP API response into our standard format.
    echo "$result" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    rows = data.get('rows', [])
    cols = [c['name'] for c in data.get('types', data.get('columns', []))]
    memories = []
    for row in rows:
        m = dict(zip(cols, row))
        if m.get('tags') and isinstance(m['tags'], str):
            try: m['tags'] = json.loads(m['tags'])
            except: m['tags'] = []
        if m.get('key_name'):
            m['key'] = m.pop('key_name')
        else:
            m.pop('key_name', None)
        memories.append(m)
    print(json.dumps({'memories': memories, 'total': len(memories)}))
except Exception:
    print(json.dumps({'memories': [], 'total': 0}))
" 2>/dev/null
  fi
}

# mnemo_post_memory <json_body> — Store a memory (works in both modes).
mnemo_post_memory() {
  local body="$1"
  local mode
  mode=$(mnemo_mode)

  if [[ "$mode" == "server" ]]; then
    mnemo_server_post "/api/memories" "$body"
  elif [[ "$mode" == "direct" ]]; then
    mnemo_direct_init
    # Parse body, build SQL with inline values (API has no param support), then insert.
    local insert_result
    insert_result=$(MNEMO_BODY="$body" MNEMO_SID="${MNEMO_SPACE_ID}" MNEMO_DB="${MNEMO_DB_NAME:-mnemos}" python3 << 'PYEOF'
import json, os, uuid

def sql_escape(val):
    if val is None:
        return 'NULL'
    s = str(val).replace("'", "''")
    return "'" + s + "'"

body = json.loads(os.environ['MNEMO_BODY'])
mid = str(uuid.uuid4())
sid = os.environ['MNEMO_SID']
content = body.get('content', '')
key = body.get('key')
source = body.get('source')
tags = json.dumps(body.get('tags', []))
metadata = json.dumps(body.get('metadata')) if body.get('metadata') else None

db = os.environ.get('MNEMO_DB', 'mnemos')
sql = 'INSERT INTO {}.memories (id, space_id, content, key_name, source, tags, metadata, version, updated_by) VALUES ({}, {}, {}, {}, {}, {}, {}, 1, {})'.format(
    db, sql_escape(mid), sql_escape(sid), sql_escape(content),
    sql_escape(key), sql_escape(source), sql_escape(tags),
    sql_escape(metadata), sql_escape(source))

print(json.dumps({'sql': sql, 'id': mid}))
PYEOF
    ) || { echo '{"error":"failed to build SQL"}'; return 1; }

    local sql mid
    sql=$(echo "$insert_result" | python3 -c "import json,sys; print(json.load(sys.stdin)['sql'])")
    mid=$(echo "$insert_result" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    mnemo_sql "$sql" >/dev/null 2>&1
    echo "{\"id\":\"${mid}\"}"
  fi
}

# mnemo_search <query> [limit] — Search memories (works in both modes).
mnemo_search() {
  local query="$1"
  local limit="${2:-10}"
  local mode
  mode=$(mnemo_mode)

  if [[ "$mode" == "server" ]]; then
    local encoded_q
    encoded_q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query'))" 2>/dev/null || echo "$query")
    mnemo_server_get "/api/memories?q=${encoded_q}&limit=${limit}"
  elif [[ "$mode" == "direct" ]]; then
    mnemo_direct_init

    local db="${MNEMO_DB_NAME:-mnemos}"
    local sid="${MNEMO_SPACE_ID}"

    if [[ -n "${MNEMO_AUTO_EMBED_MODEL:-}" && "${MNEMO_VECTOR_LEG_DISABLED:-0}" != "1" ]]; then
      local result
      result=$(MNEMO_Q="$query" \
               MNEMO_LIMIT="$limit" \
               MNEMO_SID="$sid" \
               MNEMO_DB="$db" \
               MNEMO_MODEL="$MNEMO_AUTO_EMBED_MODEL" \
               MNEMO_FTS="${MNEMO_FTS_AVAILABLE:-0}" \
               MNEMO_DB_HOST="$MNEMO_DB_HOST" \
               MNEMO_DB_USER="$MNEMO_DB_USER" \
               MNEMO_DB_PASS="$MNEMO_DB_PASS" \
               python3 << 'PYEOF'
import json, os, urllib.request, base64

db    = os.environ['MNEMO_DB']
sid   = os.environ['MNEMO_SID']
q     = os.environ['MNEMO_Q']
lim   = int(os.environ['MNEMO_LIMIT'])
fetch = lim * 3
fts   = os.environ.get('MNEMO_FTS', '0') == '1'

def sql_escape(s):
    return s.replace("'", "''") if s else ''

eq = sql_escape(q)

vec_sql = (
    f"SELECT id, content, key_name, source, tags, version, updated_by, created_at, updated_at, "
    f"VEC_EMBED_COSINE_DISTANCE(embedding, '{eq}') AS distance "
    f"FROM {db}.memories "
    f"WHERE space_id = '{sid}' AND embedding IS NOT NULL "
    f"ORDER BY VEC_EMBED_COSINE_DISTANCE(embedding, '{eq}') "
    f"LIMIT {fetch}"
)

if fts:
    kw_sql = (
        f"SELECT id, content, key_name, source, tags, version, updated_by, created_at, updated_at, "
        f"fts_match_word('{eq}', content) AS fts_score "
        f"FROM {db}.memories "
        f"WHERE space_id = '{sid}' AND fts_match_word('{eq}', content) "
        f"ORDER BY fts_match_word('{eq}', content) DESC "
        f"LIMIT {fetch}"
    )
else:
    kw_sql = (
        f"SELECT id, content, key_name, source, tags, version, updated_by, created_at, updated_at "
        f"FROM {db}.memories "
        f"WHERE space_id = '{sid}' AND content LIKE CONCAT('%', '{eq}', '%') "
        f"ORDER BY updated_at DESC "
        f"LIMIT {fetch}"
    )

host  = os.environ['MNEMO_DB_HOST']
user  = os.environ['MNEMO_DB_USER']
passw = os.environ['MNEMO_DB_PASS']
url   = f"https://http-{host}/v1beta/sql"
creds = base64.b64encode(f"{user}:{passw}".encode()).decode()
hdrs  = {"Authorization": f"Basic {creds}", "Content-Type": "application/json"}

def run_sql(sql):
    body = json.dumps({"database": db, "query": sql}).encode()
    req  = urllib.request.Request(url, data=body, headers=hdrs)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def parse_rows(data):
    cols = [c['name'] for c in data.get('types', data.get('columns', []))]
    rows = []
    for row in data.get('rows', []):
        m = dict(zip(cols, row))
        if m.get('tags') and isinstance(m['tags'], str):
            try: m['tags'] = json.loads(m['tags'])
            except: m['tags'] = []
        if m.get('key_name'):
            m['key'] = m.pop('key_name')
        else:
            m.pop('key_name', None)
        rows.append(m)
    return rows

try:    vec_rows = parse_rows(run_sql(vec_sql))
except: vec_rows = []
try:    kw_rows  = parse_rows(run_sql(kw_sql))
except: kw_rows  = []

K = 60.0
scores, mems = {}, {}
for rank, m in enumerate(kw_rows):
    mid = m['id']
    scores[mid] = scores.get(mid, 0.0) + 1.0 / (K + rank + 1)
    mems[mid] = m
for rank, m in enumerate(vec_rows):
    mid = m['id']
    scores[mid] = scores.get(mid, 0.0) + 1.0 / (K + rank + 1)
    if mid not in mems: mems[mid] = m

ranked = sorted(scores, key=lambda i: scores[i], reverse=True)
memories = [dict(**mems[mid], score=round(scores[mid], 6)) for mid in ranked[:lim]]
print(json.dumps({'memories': memories, 'total': len(scores)}))
PYEOF
      ) || result='{"memories":[],"total":0}'
      echo "$result"
    else
      local result
      if [[ "${MNEMO_FTS_AVAILABLE:-0}" == "1" ]]; then
        result=$(MNEMO_Q="$query" \
                 MNEMO_LIMIT="$limit" \
                 MNEMO_SID="$sid" \
                 MNEMO_DB="$db" \
                 MNEMO_DB_HOST="$MNEMO_DB_HOST" \
                 MNEMO_DB_USER="$MNEMO_DB_USER" \
                 MNEMO_DB_PASS="$MNEMO_DB_PASS" \
                 python3 << 'PYEOF'
import json, os, urllib.request, base64

db   = os.environ['MNEMO_DB']
sid  = os.environ['MNEMO_SID']
q    = os.environ['MNEMO_Q']
lim  = int(os.environ['MNEMO_LIMIT'])
fetch = lim * 3

def sql_escape(s):
    return s.replace("'", "''") if s else ''

eq = sql_escape(q)

fts_sql = (
    f"SELECT id, content, key_name, source, tags, version, updated_by, created_at, updated_at, "
    f"fts_match_word('{eq}', content) AS fts_score "
    f"FROM {db}.memories "
    f"WHERE space_id = '{sid}' AND fts_match_word('{eq}', content) "
    f"ORDER BY fts_match_word('{eq}', content) DESC "
    f"LIMIT {fetch}"
)

host  = os.environ['MNEMO_DB_HOST']
user  = os.environ['MNEMO_DB_USER']
passw = os.environ['MNEMO_DB_PASS']
url   = f"https://http-{host}/v1beta/sql"
creds = base64.b64encode(f"{user}:{passw}".encode()).decode()
hdrs  = {"Authorization": f"Basic {creds}", "Content-Type": "application/json"}

def run_sql(sql):
    body = json.dumps({"database": db, "query": sql}).encode()
    req  = urllib.request.Request(url, data=body, headers=hdrs)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def parse_rows(data):
    cols = [c['name'] for c in data.get('types', data.get('columns', []))]
    rows = []
    for row in data.get('rows', []):
        m = dict(zip(cols, row))
        if m.get('tags') and isinstance(m['tags'], str):
            try: m['tags'] = json.loads(m['tags'])
            except: m['tags'] = []
        if m.get('key_name'):
            m['key'] = m.pop('key_name')
        else:
            m.pop('key_name', None)
        rows.append(m)
    return rows

try:
    fts_rows = parse_rows(run_sql(fts_sql))
except:
    fts_rows = []

memories = [dict(**m, score=round(float(m.get('fts_score', 0) or 0), 6)) for m in fts_rows[:lim]]
print(json.dumps({'memories': memories, 'total': len(fts_rows)}))
PYEOF
        ) || result='{"memories":[],"total":0}'
      else
        result=$(mnemo_sql "SELECT id, content, key_name, source, tags, version, updated_by, created_at, updated_at FROM ${db}.memories WHERE space_id = '${MNEMO_SPACE_ID}' AND content LIKE CONCAT('%', '${query}', '%') ORDER BY updated_at DESC LIMIT ${limit}" 2>/dev/null || echo "")
        if [[ -z "$result" ]]; then
          result='{"memories":[],"total":0}'
        else
          result=$(echo "$result" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    rows = data.get('rows', [])
    cols = [c['name'] for c in data.get('types', data.get('columns', []))]
    memories = []
    for row in rows:
        m = dict(zip(cols, row))
        if m.get('tags') and isinstance(m['tags'], str):
            try: m['tags'] = json.loads(m['tags'])
            except: m['tags'] = []
        if m.get('key_name'):
            m['key'] = m.pop('key_name')
        else:
            m.pop('key_name', None)
        memories.append(m)
    print(json.dumps({'memories': memories, 'total': len(memories)}))
except Exception:
    print(json.dumps({'memories': [], 'total': 0}))
" 2>/dev/null || echo '{"memories":[],"total":0}')
        fi
      fi
      echo "$result"
    fi
  fi
}

# read_stdin — Read stdin (hook input JSON) into $HOOK_INPUT.
# Uses read with timeout to avoid hanging if stdin is not provided.
read_stdin() {
  local input=""
  if read -t 2 -r input 2>/dev/null; then
    HOOK_INPUT="$input"
  else
    HOOK_INPUT="{}"
  fi
}
