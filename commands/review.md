---
allowed-tools: Read, Glob, Grep, Agent, Bash(git status:*), Bash(git diff:*)
argument-hint: [受け入れ条件や気になる点。省略可]
description: 既存の変更に対して機械検証とレビューだけを回す
---

## 対象の変更

- 変更ファイル: !`git status --porcelain`
- 差分の概要: !`git diff --stat`

## 補足

$ARGUMENTS

## 進め方

1. orchestra:verifier に機械的検証を委譲する。変更内容に応じて必要な検証だけを選ばせる。
2. orchestra:reviewer にレビューを委譲する。上の補足に受け入れ条件があれば、それを渡す。
3. リリース前など影響が大きい変更の場合のみ、orchestra:critic にも委譲する。小さな変更では呼ばない。
4. 3 者の結果を集約する。集約時にあなた自身が新しい判断を足さない。件数と内容をそのまま整理する。
5. 以下の形式で報告する。

```
## 機械的検証
- pass: N / fail: N / 検証不能: N

## blocker
1. [出典: verifier|reviewer|critic] 場所 — 内容 — 直し方

## warning / suggestion
- ...

## 結論
- blocker N 件。マージ可否: 可 / 不可
```

修正はこのコマンドでは行いません。修正まで進める場合は `/orchestra:run` を使ってください。
