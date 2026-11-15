#!/usr/bin/env bash
# =======
# 1. 準備
# =======
set -euo pipefail
cd "$(dirname "$0")/.."

# =================
# 2. Prettierの適用
# =================
npx prettier --write "src/**/*.ts" "package.json" "tsconfig.json" "ecosystem.config.cjs" ".github/workflows/*.yml" ".github/dependabot.yml"
