#!/usr/bin/env node
/**
 * 生成干净的 PUP 便携版数据库
 * 只创建表结构，不包含任何开发数据
 */

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const distServerDir = process.argv[2];
if (!distServerDir) {
    console.error('用法: node init-clean-db.cjs <dist/server 目录路径>');
    process.exit(1);
}

const dataDir = path.join(distServerDir, 'data');
const profilesDbPath = path.join(distServerDir, 'profiles.db');
const mainDbPath = path.join(dataDir, 'omnifingerprint.db');

// 确保 data 目录存在
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

console.log('[init-db] 正在生成干净的数据库模板...');

// 1. 创建主数据库 (服务器启动时通过 CREATE TABLE IF NOT EXISTS 自动建表)
// 只需要创建一个空文件即可，服务器启动时自动完成初始化
fs.writeFileSync(mainDbPath, '');
console.log('[init-db] ✅ 已创建空 main db:', path.relative(process.cwd(), mainDbPath));

// 2. 创建 credentials 数据库 (profiles.db)
// 需要预建 login_credentials 表（服务器不自动创建此表）
const credDb = new sqlite3.Database(profilesDbPath);

credDb.serialize(() => {
    credbQuery(credDb, `
        CREATE TABLE IF NOT EXISTS login_credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT,
            website_domain TEXT,
            website_name TEXT,
            username TEXT,
            password_encrypted TEXT,
            form_selectors TEXT,
            is_default INTEGER DEFAULT 0,
            auto_login INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 也可以创建 profiles 表（虽然主数据库也有，但有些地方直接读 profiles.db）
    credbQuery(credDb, `
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT,
            account_name TEXT,
            account_email TEXT,
            account_password TEXT,
            account TEXT,
            start_url TEXT,
            user_agent TEXT,
            proxy TEXT,
            proxy_enabled INTEGER,
            proxy_type TEXT,
            proxy_host TEXT,
            proxy_port TEXT,
            proxy_username TEXT,
            proxy_password TEXT,
            account_notes TEXT,
            account_tokens TEXT,
            account_cookies TEXT,
            account_status TEXT,
            seq INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

function credbQuery(db, sql) {
    db.run(sql, (err) => {
        if (err) {
            console.error('[init-db] ❌ 创建表失败:', err.message);
        } else {
            const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)?.[1] || 'unknown';
            console.log(`[init-db] ✅ 已创建表: ${tableName}`);
        }
    });
}

// 等待所有操作完成
setTimeout(() => {
    credDb.close();
    console.log('[init-db] ✅ 数据库模板生成完毕！');
    console.log('[init-db] ⚠️  注意：此数据库不包含任何开发数据');
}, 500);
