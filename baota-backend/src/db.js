/**
 * D1 → MySQL 兼容层（宝塔版后端专用）
 *
 * 让 Cloudflare Pages Functions 里基于 env.DB（D1/SQLite）的 handler 代码
 * 原样跑在 Node + MariaDB 上：
 *   - 链式 API：prepare(sql).bind(...).all()/.run()/.first()
 *   - env.DB.exec(sql) / env.DB.batch([stmts])
 *   - SQLite 方言自动翻译为 MySQL 方言
 *   - 对已存在的表/列，DDL 自动跳过（避免每次请求重复建表/加列报错）
 */
import mysql from 'mysql2/promise';

// ---------- 基础工具 ----------

/** 按顶层逗号分割（忽略括号内与引号内的逗号） */
function splitTopLevel(str, sep = ',') {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null; // ', ", `
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === quote && str[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 把 SQL 中的 SQLite 方言翻译为 MySQL/MariaDB 方言 */
export function toMySql(sql) {
  let s = String(sql || '').trim();

  // 1) sqlite_master 探测 -> information_schema（命中与否都返回一行 name，语义等价）
  if (/sqlite_master/i.test(s) && /FROM\s+sqlite_master/i.test(s)) {
    const m = s.match(/name\s*=\s*'([^']+)'/);
    const tableName = m ? m[1] : '';
    return {
      special: 'table_exists',
      tableName,
      sql: tableName
        ? `SELECT '${tableName}' AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${tableName}'`
        : 'SELECT NULL AS name LIMIT 0',
    };
  }

  // 2) INSERT OR IGNORE -> INSERT IGNORE
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  // 3) INSERT OR REPLACE -> REPLACE INTO
  s = s.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');
  // 4) ON CONFLICT(cols) DO UPDATE SET a=excluded.a,... -> ON DUPLICATE KEY UPDATE
  s = s.replace(/ON\s+CONFLICT\s*\(([^)]*)\)\s*DO\s+UPDATE\s+SET\s+([\s\S]*)$/i, (whole, _pk, setClauseRaw) => {
    const setClause = setClauseRaw.replace(/;\s*$/, '');
    const assignments = splitTopLevel(setClause).map(a => {
      const m2 = a.match(/^\s*`?([A-Za-z_][\w]*)`?\s*=\s*excluded\.`?([A-Za-z_][\w]*)`?\s*$/);
      if (m2) return `\`${m2[1]}\` = VALUES(\`${m2[2]}\`)`;
      return a.trim();
    }).join(', ');
    return `ON DUPLICATE KEY UPDATE ${assignments}`;
  });
  // 5) CAST(x AS TEXT) -> CAST(x AS CHAR)；CAST(x AS INTEGER) -> CAST(x AS SIGNED)
  s = s.replace(/CAST\s*\(\s*([\s\S]*?)\s+AS\s+TEXT\s*\)/gi, 'CAST($1 AS CHAR)');
  s = s.replace(/CAST\s*\(\s*([\s\S]*?)\s+AS\s+INTEGER\s*\)/gi, 'CAST($1 AS SIGNED)');
  // 6) 双引号标识符 -> 反引号（本工程 SQL 字符串字面量均用单引号，安全）
  s = s.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '`$1`');
  return { special: null, sql: s };
}

/** SQLite 列类型 -> MySQL 列类型（用于兜底 DDL 转换） */
function colTypeToMySql(rest) {
  let r = rest.trim();
  r = r.replace(/\bINTEGER\b/gi, 'INT');
  r = r.replace(/\bREAL\b/gi, 'DOUBLE');
  r = r.replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
  r = r.replace(/\bTEXT\b/gi, 'VARCHAR(191)');
  // TEXT 主键必须限长（上面已统一转 VARCHAR(191)）
  return r;
}

// ---------- D1 Statement ----------

class D1Stmt {
  constructor(db, sql) {
    this.db = db;
    this.rawSql = sql;
    this.params = [];
  }
  bind(...args) {
    this.params = args;
    return this;
  }
  async all() {
    const translated = toMySql(this.rawSql);
    if (translated.special) {
      const [rows] = await this.db.pool.query(translated.sql);
      return { results: rows };
    }
    const [rows] = await this.db.pool.query(translated.sql, this.params);
    return { results: rows };
  }
  async run() {
    const res = await this.db.execOne(this.rawSql, this.params);
    return { meta: { changes: res.changes, last_row_id: res.lastId } };
  }
  async first() {
    const t = toMySql(this.rawSql);
    let rows;
    if (t.special) {
      [rows] = await this.db.pool.query(t.sql);
    } else {
      [rows] = await this.db.pool.query(t.sql, this.params);
    }
    return rows && rows.length ? rows[0] : null;
  }
}

// ---------- D1 DB ----------

export class D1DB {
  constructor(pool) {
    this.pool = pool;
    this.tables = new Map(); // name(lower) -> Set(colLower)
    this.schemaLoaded = false;
  }

  /** 启动时/首查前加载 information_schema，用于 DDL 自动跳过 */
  async ensureSchema() {
    if (this.schemaLoaded) return;
    const [rows] = await this.pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = DATABASE()`
    );
    const tables = new Map();
    for (const r of rows) {
      const tn = String(r.table_name).toLowerCase();
      if (!tables.has(tn)) tables.set(tn, new Set());
      tables.get(tn).add(String(r.column_name).toLowerCase());
    }
    this.tables = tables;
    this.schemaLoaded = true;
  }

  tableExists(table) {
    return this.tables.has(String(table).toLowerCase());
  }

  columnExists(table, col) {
    const t = this.tables.get(String(table).toLowerCase());
    return t ? t.has(String(col).toLowerCase()) : false;
  }

  prepare(sql) {
    return new D1Stmt(this, sql);
  }

  async exec(sql) {
    // D1 exec 允许多条语句；这里按顶层分号切分后逐条执行
    const statements = splitTopLevel(String(sql), ';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await this.execOne(stmt, []);
    }
    return {};
  }

  async batch(statements) {
    if (!Array.isArray(statements) || statements.length === 0) return [];
    const conn = await this.pool.getConnection();
    const results = [];
    try {
      await conn.beginTransaction();
      for (const stmt of statements) {
        const r = await this.execOneOn(conn, stmt.rawSql, stmt.params || []);
        results.push(r);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    return results;
  }

  /** 处理单条语句（含 DDL 自动跳过/翻译） */
  async execOne(sql, params = []) {
    return this.execOneOn(this.pool, sql, params);
  }

  async execOneOn(conn, sql, params = []) {
    await this.ensureSchema();
    const raw = String(sql).trim();

    // ---- DDL：表已存在/列已存在则跳过 ----
    const createMatch = raw.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([A-Za-z_][\w]*)`?/i);
    if (createMatch) {
      const table = createMatch[1];
      if (this.tableExists(table)) return { changes: 0, lastId: 0 }; // 幂等跳过
      // 表不存在时兜底转换（正常情况下 schema 已由 sql/schema-mysql.sql 预建）
      let ddl = raw
        .replace(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+/i, 'CREATE TABLE IF NOT EXISTS ')
        .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE')
        .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/gi, 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY')
        .replace(/\bINTEGER\b/gi, 'INT')
        .replace(/\bREAL\b/gi, 'DOUBLE')
        .replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
      // TEXT 主键/唯一键限长：把 “TEXT PRIMARY KEY”/“TEXT NOT NULL,” PK 复合场景做常见替换
      ddl = ddl.replace(/\bTEXT PRIMARY KEY\b/gi, 'VARCHAR(191) PRIMARY KEY');
      // 复合主键里的 TEXT id/profile_id 无法可靠自动转换，表缺失时交由外部报错提示
      if (/\bTEXT\b/i.test(ddl) && /\bPRIMARY KEY\s*\(/i.test(ddl)) {
        throw new Error(`[baota-backend] 表 ${table} 不存在且 CREATE 含 TEXT 复合主键，请先用 sql/schema-mysql.sql 建表。`);
      }
      ddl = ddl.replace(/\bTEXT\b/gi, 'VARCHAR(191)');
      const [r] = await conn.query(ddl);
      this.schemaLoaded = false; // 强制刷新
      await this.ensureSchema();
      return { changes: r.affectedRows || 0, lastId: r.insertId || 0 };
    }

    const alterMatch = raw.match(/^ALTER\s+TABLE\s+`?([A-Za-z_][\w]*)`?\s+ADD(?:\s+COLUMN)?\s+`?([A-Za-z_][\w]*)`?/i);
    if (alterMatch) {
      const table = alterMatch[1];
      const col = alterMatch[2];
      if (this.columnExists(table, col)) return { changes: 0, lastId: 0 }; // 已存在跳过
      const alterSql = `ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${colTypeToMySql(raw.slice(alterMatch[0].length))}`;
      try {
        const [r] = await conn.query(alterSql);
        this.schemaLoaded = false;
        await this.ensureSchema();
        return { changes: r.affectedRows || 0, lastId: r.insertId || 0 };
      } catch (e) {
        if (/duplicate column|already exists/i.test(String(e.message))) return { changes: 0, lastId: 0 };
        throw e;
      }
    }

    // ---- 其余（DML / 其它 DDL）----
    const t = toMySql(raw);
    if (t.special) {
      const [rows] = await conn.query(t.sql);
      return { changes: rows.length ? 1 : 0, lastId: 0, rows };
    }
    const [r] = await conn.query(t.sql, params);
    return { changes: r.affectedRows || 0, lastId: r.insertId || 0 };
  }
}

/** 建池 + D1DB */
export async function createD1Env(config) {
  const pool = mysql.createPool({
    host: config.DB_HOST || '127.0.0.1',
    port: Number(config.DB_PORT || 3306),
    user: config.DB_USER,
    password: config.DB_PASS,
    database: config.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(config.DB_POOL_LIMIT || 10),
    charset: 'utf8mb4',
    decimalNumbers: true,
    timezone: '+00:00',
    dateStrings: false,
  });
  const db = new D1DB(pool);
  await db.ensureSchema();
  return {
    DB: db,
    PUPPETEER_API_SECRET: config.PUPPETEER_API_SECRET || '',
    DB_INITIALIZED: '1',
  };
}
