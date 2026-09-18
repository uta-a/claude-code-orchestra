---
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs":*)
description: 検証ゲート(Stop フック)を解除する
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/orch.mjs" stop`

上のコマンドの出力を、そのままユーザーに伝えてください。
出力が無い、またはエラーになっている場合は、解除できたとは言わず、その内容をそのまま伝えてください。
再度有効にする場合は `/orchestra:run` を実行するよう案内してください。
