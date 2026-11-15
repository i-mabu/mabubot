// ===== 1. 概要 =====
// pm2 ecosystem file for mabusaba.
//
// Start with:  pm2 start ecosystem.config.cjs
// Then make it survive a server reboot with:  pm2 startup  (run the
// command it prints)  and  pm2 save
//
// Why this file loads .env itself: pm2 does not load a .env file, and
// this bot does not auto-load one either (no dotenv dependency), so
// DISCORD_TOKEN / DISCORD_APPLICATION_ID would otherwise be missing.
// This file parses the repo-root `.env` and passes it to the app as
// environment variables. Secrets stay in `.env` (gitignored) — never
// put them in this file.
//
// Node version: the bot uses Node's built-in `node:sqlite`, which on
// Node 22 still needs `--experimental-sqlite`. This file adds that
// flag automatically on Node < 24; on Node 24+ it is not needed.

// ===== 2. 環境変数の読み込み =====
const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile(file) {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return env;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

// ===== 3. アプリ設定 =====
const envFromFile = loadEnvFile(path.join(__dirname, ".env"));
if (!envFromFile.DISCORD_TOKEN || !envFromFile.DISCORD_APPLICATION_ID) {
  console.error(
    "[mabusaba] .env に DISCORD_TOKEN / DISCORD_APPLICATION_ID がありません。先に .env を用意してください。",
  );
}

const nodeMajor = Number(process.versions.node.split(".")[0]);

module.exports = {
  apps: [
    {
      name: "mabusaba",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      kill_timeout: 5000,
      // Node < 24 needs this flag for `node:sqlite`.
      ...(nodeMajor < 24 ? { node_args: "--experimental-sqlite" } : {}),
      env: {
        NODE_ENV: "production",
        ...envFromFile,
      },
    },
  ],
};
