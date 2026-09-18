# orchestra

Claude Code 用の軽量オーケストレーションプラグイン。

計画・実装・機械検証・レビューを別々のサブエージェントに分け、`/コマンド` から一連のループを回す。
完了判定は Stop フックの検証ゲートが握り、周回上限に達したら人間に返す。

## 設計方針

1. 判定権限の分離をプロンプトではなくツール権限で強制する。
   書き込みツール（Write / Edit）を持つのは implementer だけ。
   読み取り専用エージェント（planner / explorer / reviewer / critic）の Bash は、PreToolUse フックで git 参照系と `ls` / `pwd` に絞る。
   verifier は検証コマンドを実行するため Bash を制限していない。コードを修正しないことは本文の制約による。
   逆に実装エージェントは完了判定を出力しない。
2. 機械的検証は専用エージェントに切り出し、変更内容に応じて必要なものだけ選ばせる。
   全部を毎回回すと遅く、lint だけで済ませると型崩れを見逃す。
3. 検証の最終ゲートはコードに置く。
   Stop フックが実際にコマンドを実行し、終了コードで判定する。エージェントの自己申告は根拠にしない。
4. 失敗の種別を区別する。
   「テストが落ちた」と「コマンドが存在しない」を混同すると、インフラ由来の失敗でループが空回りしてトークンだけ消える。
   後者は「検証不能」として block しない。
5. 予算カウンタを持つ。周回数と検証時間に上限を設け、超えたら止める。
   各エージェントにも `maxTurns` を設定してある（implementer は 100、それ以外は 40）。

## 構成

```
orchestra/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── agents/
│   ├── planner.md      計画のみ。コードを書かない (opus)
│   ├── explorer.md     調査。読み取り専用。要約だけ返す (sonnet)
│   ├── implementer.md  実装。完了判定はしない (sonnet)
│   ├── verifier.md     機械的検証。修正しない (haiku)
│   ├── reviewer.md     意味評価。読み取り専用 (sonnet)
│   └── critic.md       敵対的批評。読み取り専用 (opus)
├── commands/
│   ├── run.md        /orchestra:run       一周まわす
│   ├── plan.md       /orchestra:plan      計画のみ
│   ├── review.md     /orchestra:review    既存変更の検証とレビューのみ
│   ├── parallel.md   /orchestra:parallel  独立した調査を並列実行
│   └── off.md        /orchestra:off       検証ゲートを解除
├── hooks/hooks.json
├── scripts/
│   ├── orch.mjs            ループ状態の管理 CLI
│   ├── arm-gate.mjs        UserPromptSubmit フック本体。ユーザーの次の発話でゲートを arm する
│   ├── stop-gate.mjs       Stop フック本体
│   └── readonly-guard.mjs  PreToolUse フック本体。読み取り専用エージェントの Bash を絞る
├── tests/                  node --test 用のテスト
├── examples/config.json    .orchestra/config.json の例
└── .gitignore
```

エージェントは `orchestra:planner` のように名前空間付きで参照する。

## インストール

開発中はインストールせずに読み込める。

```
claude --plugin-dir /path/to/orchestra
```

単一プラグインのマーケットプレイスとして `.claude-plugin/marketplace.json` を同梱してある。

```
/plugin marketplace add uta-a/claude-code-orchestra
/plugin install orchestra
```

フォークして配布する場合は、`marketplace.json` の `owner` を自分の情報に書き換えること。

## 使い方

```
/orchestra:run ログインフォームのバリデーションを追加する
```

1. 調査 → 計画 → 承認待ちで一度止まる
2. 承認後に実装 → 機械検証 → レビュー
3. blocker があれば指摘を制約に変換して実装へ戻す（差し戻しは最大 3 回）
4. blocker 0 件で完了。検証ゲートは、検証が通った時点で自動的に解除される

途中で抜けたい場合だけ `/orchestra:off` が必要になる。

`/orchestra:run` と `/orchestra:off` は検証ゲートを操作するので、ユーザーが明示的に呼んだときだけ動く（`disable-model-invocation: true`）。

## 検証ゲートの挙動

`/orchestra:run` の直後、ゲートは未 arm の状態で作られる。計画の提示に対するユーザーの次の発話（承認でも修正依頼でも）で、UserPromptSubmit フック（`scripts/arm-gate.mjs`）が作業ツリーの指紋（baseline）を取り直して arm する。
`/orchestra:` で始まる入力では arm しない。このフックは何も出力しない。
未 arm の間の停止（計画の承認待ち）では検証しないので、承認前に別の作業で作業ツリーが変わってもゲートは外れない。

指紋は HEAD、`git status`、`git diff HEAD`、未追跡ファイルの大きさと更新時刻から作る。コミットも変更として数える。`.orchestra/` 配下は指紋に含めない。
git で指紋が取れない場所（git 管理外、コミットが 1 つも無いリポジトリ）では、ファイルの走査（相対パス・大きさ・更新時刻）に切り替える。
走査は `.git` / `node_modules` / `.orchestra` を除外し、`.gitignore` は見ない。20000 エントリまたは 5 秒を超えたら指紋なしとして扱う。

arm 後は、Claude が応答を終えようとするたびに Stop フックが次の順で判定する。

1. 開始から 24 時間を超えたゲートは、検証せず解除する（放置されたゲートが後日の無関係な作業を block しないため）。未 arm でもこの判定は行う。
2. arm 時から変更が無い間は、検証せずゲートを維持する。
3. round が maxRounds（既定 5、1〜20）に達していたら、ゲートを解除して人間に返す。
4. block 後に何も変更せず止まった場合は、報告のための停止とみなして許可する。ゲートは維持する。
5. 変更後の停止では検証コマンドを順に実行する。
   - fail が 1 件でもあれば block して round を進める。
   - fail が無ければ、ゲートを自動で解除する。

ゲートの解除や、検証が通っていないままの停止の許可は、`systemMessage` でユーザーに知らせる。

検証には全コマンド合計で 840 秒の時間予算がある。
コマンド未検出、時間切れ、出力の上限超過は「検証不能」として block しない。fail が無ければ、検証不能のコマンドを列挙したうえでゲートを解除する。
実行できたコマンドが 1 つも無い場合は「通過」ではなく「検証できませんでした」と表示して解除する。
検証コマンドが 1 つも見つからない場合も、block せずゲートを解除する。このときは `/orchestra:run` の開始時に警告が出る。

検証コマンドが時間切れ、または出力の上限（16MB）を超えたときは、プロセスツリーごと強制終了する（Windows は `taskkill /T /F`、それ以外はプロセスグループへの SIGKILL）。

`.orchestra/config.json` だけを書き換えても変更とはみなされない。検証コマンドを直したあと再検証させたいときは、`/orchestra:off` してから `/orchestra:run` をやり直す。
ゲートの状態（有効か、arm 済みか、周回数）は `node scripts/orch.mjs status` で確認できる。

指紋が取れない場所（git 管理外で、ファイル走査も上限を超える場合）では変更検知ができない。
この場合、block した直後の停止はそのまま許可されるので、block は連続では 1 回だけになる。
また 2 の判定も効かないため、arm 後に変更せず止まっただけでも検証が走り、通ればゲートが外れる。

周回の上限は 2 種類ある。

- レビューでの差し戻し（実装 → 検証 → レビューの周回）: 最大 3 回。オーケストレーターへの指示による。
- 検証ゲートの block: 最大 maxRounds 回。Stop フックがコードで強制する。

## 読み取り専用ガード

サブエージェントの frontmatter の `tools` には `Bash(git diff:*)` のような権限ルール形式を書けない。
そこで読み取り専用エージェントの `tools` には素の `Bash` を入れ、PreToolUse フック（`scripts/readonly-guard.mjs`）でコマンドを絞っている。

- 対象は、フック入力の `agent_type` が `orchestra:planner` / `orchestra:explorer` / `orchestra:reviewer` / `orchestra:critic` の Bash 呼び出しだけ。
  メイン会話、implementer、verifier、他のプラグインやユーザー定義の同名エージェントには何もしない。
  `agent_type` が名前空間付きで入ることは Claude Code 2.1.276 の実機で確認した。
- 通すのは `git diff / log / status / show / blame / ls-files / rev-parse`（前置オプションは `--no-pager` と `-C <path>` のみ）と `ls` / `pwd`。
  `-C` に指定できるのはプロジェクト内の相対パスだけで、1 回だけ（絶対パス、ドライブ指定、`..`、`~` は拒否）。
- パイプ、リダイレクト、`;`、`&`、`$`、バッククォート、バックスラッシュ、グロブ文字（`* ? [`）、波括弧は拒否する。
  シェルの解釈とガードの解釈がずれる書き方は、引用符の中でも拒否する。
- ファイルに書き込む、または外部プログラムを起動するオプションは、省略形も含めて拒否する。
  `--output`、`--ext-diff`、`--no-index`、`--textconv`、`--show-signature`、`--help`、書式指定の `%G`。

これはエージェントが役割から外れるのを防ぐためのもので、サンドボックスではない。次のものは止めていない。

- リポジトリ側の git 設定による外部コマンドの起動（既定で有効な textconv、`core.fsmonitor`、`log.showSignature` など）。
  プロジェクト内に埋め込まれた bare リポジトリの設定も、`git -C <相対パス>` 経由で有効になる。
  気になる場合は `git config --global safe.bareRepository explicit` を設定しておく。
- プロジェクト外のファイルの読み取り（`ls` のパスは制限していない。同じエージェントが Read でも読めるため）。
- `-C` の先がシンボリックリンクやジャンクションでプロジェクト外を指している場合。

## 検証コマンドの設定

デフォルトでは `package.json` の scripts から `typecheck`（または `type-check` / `tsc`）、`lint`、`test` を順に拾う。
パッケージマネージャはロックファイルから判定する。

明示したい場合はプロジェクト直下に `.orchestra/config.json` を置く。`examples/config.json` をコピーして書き換えるとよい。

```json
{
  "maxRounds": 5,
  "commands": [
    "pnpm typecheck",
    "pnpm lint",
    "pnpm vitest run --changed"
  ]
}
```

`.orchestra/state.json` は実行中の状態ファイルなので、利用側のプロジェクトの `.gitignore` に `.orchestra/state.json` を追加しておく。

## モデルの割り当て

| エージェント | model | 理由 |
| :-- | :-- | :-- |
| planner | opus | 分解と受け入れ条件の設計 |
| critic | opus | 壊れる条件を能動的に探す |
| explorer / implementer / reviewer | sonnet | 調査・実装・レビューの標準的な作業 |
| verifier | haiku | コマンドを実行して結果を報告するだけ |

モデルの解決順序は「呼び出し時の model 指定 > frontmatter の `model` > 環境変数 `CLAUDE_CODE_SUBAGENT_MODEL` > 親会話のモデル」（公式ドキュメントの記載。過去に変わったことがあるので、使っているバージョンのドキュメントで確認すること）。
このプラグインのエージェントは frontmatter で model を固定しているので、上書きするには次のどちらかを使う。

- 各エージェントの frontmatter の `model` を書き換える。
- `CLAUDE_CODE_SUBAGENT_MODEL` に加えて `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` を設定する（v2.1.257 以降）。
  `CLAUDE_CODE_SUBAGENT_MODEL` だけでは frontmatter の指定が優先される。

プラグインから env を配布する手段は無いので、利用者が自分の `settings.json` の `env` に書く。

## 注意点

- Stop フックは `.orchestra/state.json` が active のときだけ働く。
  `/orchestra:run` を使っていない通常セッションでは何もしない。
- `.orchestra/config.json` の `commands` はシェルでそのまま実行され、その一覧は `/orchestra:run` のプロンプトにも埋め込まれる。
  信頼できないリポジトリで `/orchestra:run` を使わないこと。
- `/orchestra:run` と `/orchestra:off` が `allowed-tools` で許可する `node` の実行は、`scripts/orch.mjs` だけに絞ってある。
- Windows では、コマンドの `!` 実行に Git Bash が必要。
- プラグイン由来のサブエージェントは frontmatter の `hooks` / `mcpServers` / `permissionMode` を無視する。
  これらが必要な場合は `.claude/agents/` にコピーして使う。
  読み取り専用エージェントの Bash 制限を frontmatter ではなくプラグイン側のフックに置いているのもこのため。
- サブエージェントはそれぞれ独立した文脈を持つため、並列度を上げるとトークン消費が急増する。
  `/orchestra:parallel` のファンアウトを 4 件までにしているのはそのため。
- 無人放置しない。Stop フックによる自律ループは、評価側が完了を誤認すると周回上限まで走り続ける。

## 開発

テストは Node.js 標準のテストランナーで書いてある。プラグインのルートで実行する。

```
node --test
```
