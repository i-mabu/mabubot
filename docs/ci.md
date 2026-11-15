# CI と整形自動化

このドキュメントは、mabubot の継続的インテグレーション（CI）とコード整形の自動化についてまとめたものです。GitHub Actions の無料枠（プライベートリポジトリ月2,000分）を節約するため、実行回数とジョブ数を絞った軽量構成にしています。

## 1. ワークフロー構成

| ワークフロー | ファイル | トリガー | 役割 |
| --- | --- | --- | --- |
| mabubot CI | `.github/workflows/ci.yml` | main への push / pull_request（ドキュメントのみの変更を除く） | 検証（チェックのみ。コードは変更しない） |
| Format (auto-fix) | `.github/workflows/format.yml` | main への push / 手動実行 | フォーマッタの自動適用と自動コミット |
| CodeQL | `.github/workflows/codeql.yml` | main への push / pull_request（対象パスの変更時のみ） / 毎週月曜 03:00 UTC | 静的セキュリティ解析 |

すべてのワークフロー共通の方針:

- トップレベルの権限は `permissions: contents: read` のみとし、追加の権限が要る場合はジョブ単位で最小限だけ付与する。
- push トリガーは main のみに絞り、PRブランチへの push と pull_request による二重起動を防ぐ。
- `concurrency` により、同一 ref の古い実行はキャンセルする（自動整形ワークフローだけは、コミット途中で止めないようキャンセルしない）。
- 各ジョブには `timeout-minutes` を設定し、ハングした実行が残り続けないようにする。

## 2. CI（ci.yml）の検証内容

単一ジョブ `check` で以下を順に実行します。

- `npm ci`
- Prettier による整形チェック（`npm run format:check`、blocking）
- 型チェック（`npm run typecheck` = `tsc --noEmit`）
- ビルド（`npm run build`）
- テスト（`npm test` = ビルド成果物に対する `node --test`）
- `npm audit --audit-level=high`（**non-blocking**。結果はログに残ります。高深刻度の脆弱性は Dependabot の更新 PR で追跡する運用とし、既知の脆弱性で恒常的に CI が落ちる状態を避けます）

## 3. CodeQL（codeql.yml）

- 対象言語: javascript-typescript
- 実行は main への push と pull_request のうち対象パス（`src/**`、`package.json`、`package-lock.json`、`.github/workflows/**`）が変わった場合と、毎週月曜 03:00 UTC のスケジュールのみ（Actions の分数節約のため）
- Code scanning（Advanced Security）は Organization 向けで、個人アカウントのプライベートリポジトリでは有効化できない。そのため結果は Code scanning へアップロードせず（`upload: never`）、SARIF を Actions の artifact（`codeql-sarif-*`、保持7日）として保存する。Organization へ移行して Code scanning を有効化した場合は、`upload` / `output` の指定と artifact 保存ステップを外せば Security タブ連携に戻せる

## 4. Dependabot（.github/dependabot.yml）

- npm（`/`）と github-actions（`/`）の更新を毎週月曜に確認し、更新 PR を自動作成します
- PR 数の抑制のため、npm は minor / patch 更新を1本の PR にグループ化し、github-actions は全更新を1本にグループ化します。同時に開く PR は各エコシステム3本まで（`open-pull-requests-limit: 3`）

## 5. 整形ルールと自動化

| 対象 | ツール | 設定 |
| --- | --- | --- |
| TypeScript / JSON / CJS / YAML | Prettier 3.10.1（devDependency に固定） | リポジトリ直下の `.prettierrc.json`。二重引用符・セミコロンあり・インデント2スペース・`printWidth` 80（既存コードの実測スタイルに合わせたもの） |
| 全般 | `.editorconfig` | 文字コード・改行コード・インデントの宣言 |

- `scripts/format.sh`（Windows は `scripts/format.ps1`）を実行すると、Prettier を一括で適用します。
- `.github/workflows/format.yml` は、main への push と手動実行（workflow_dispatch）のときに同じ整形を自動実行し、差分があれば `github-actions[bot]` が自動コミットします（メッセージに `[skip ci]` 付き）。
- CI の整形チェックは差分を検出すると失敗します（blocking）。pull_request では自動修正は行われないため、ローカルで `scripts/format.sh` を実行してから push してください。
- 任意で使える pre-commit フックもあります。有効化: `git config core.hooksPath .githooks`（Prettier がインストール済みの場合に整形チェックを行います）

## 6. ローカルでの再現コマンド

```bash
npm ci
npm run format:check
npm run typecheck
npm run build
npm test
npm audit --audit-level=high
```

## 7. コミット署名

main へのコミットは SSH 署名付きで行い、GitHub 上で「Verified」と表示されることを確認します（署名キーはアカウントの Signing key として登録済みのものを使用）。

## セクションコメント

ソースファイル内のセクション区切りは、p1228 と同じ形式に統一しています。

- セクション見出しは1行式バナー: `// ===== 1. インポート =====`（シェルやYAMLでは `# ===== 1. 見出し =====`）
- セクション内の小見出しは罫線を `-` にした1行式で、番号は「セクション番号.連番」: `// ----- 2.1 ウェルカム・自動ロール -----`
