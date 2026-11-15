# =======
# 1. 準備
# =======
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# =================
# 2. Prettierの適用
# =================
npx prettier --write "src/**/*.ts" "package.json" "tsconfig.json" "ecosystem.config.cjs" ".github/workflows/*.yml" ".github/dependabot.yml"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
