module.exports = {
  apps: [
    {
      name: "admanager-storage",
      script: "./server/storage-api-server.js",
      cwd: "./",
      env: {
        NODE_ENV: "production",
        STORAGE_PORT: "7070",
        STORAGE_SERVER_URL: "http://127.0.0.1:7070"
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G"
    }
    // ⚠️ 警告：admanager-puppeteer (puppeteer-api-server.js) 是本地客户端程序！
    // 绝对不需要也不应该部署到云端服务器。请在本地机器上运行它。
  ]
};
