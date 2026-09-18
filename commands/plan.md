---
allowed-tools: Read, Glob, Grep, Agent, Bash(git status:*), Bash(git log:*)
argument-hint: <計画したいことを一文で>
description: 実装せず、計画と受け入れ条件だけを作る
---

## 現在の状態

- 変更ファイル: !`git status --porcelain`

## 依頼

$ARGUMENTS

## 進め方

1. 前提が足りなければ orchestra:explorer に調査を委譲する。独立した調査は並列で委譲する。
2. orchestra:planner に計画を委譲する。
3. 返ってきた計画をそのまま流さず、以下を自分で確認する。
   - 受け入れ条件が観測可能な形になっているか
   - 各タスクに検証手段が付いているか
   - 触らないファイルの境界が書かれているか
   - 不明点が推測で埋められていないか
4. 不足があれば orchestra:planner に差し戻す。最大 2 回まで。
5. 確定した計画をユーザーに提示する。実装には着手しない。

このコマンドでは一切コードを書きません。実装に進む場合は `/orchestra:run` を使ってください。
