#!/usr/bin/env node
/**
 * UserPromptSubmit フック: 検証ゲートを arm する。
 *
 * /orchestra:run は start でゲートを有効化したあと、計画を提示してユーザーの承認待ちで一度止まる。
 * この停止で検証が走ると、まだ何も実装していないコードが検証を通ってゲートが外れてしまう。
 * そこで start の直後は未 arm にしておき、計画提示後のユーザーの最初の発話（承認でも修正依頼でも）で arm する。
 * arm のときに作業ツリーの指紋を取り直して baseline にするので、承認前に起きた変更は「変更なし」の基準に含まれる。
 *
 * 設計上の要点
 * 1. /orchestra: で始まるプロンプトでは arm しない。
 *    /orchestra:run 自身のプロンプトで arm してしまうと、`!` による start とこのフックの前後関係に依存する。
 * 2. stdout には何も出さない。UserPromptSubmit の stdout はコンテキストに注入される。
 * 3. 何が起きても exit 0。例外や書き込み失敗でプロンプト処理を妨げない。
 *    arm できなかった場合、ゲートは未 arm のまま（検証しない側）に倒れる。
 */

import fs from "node:fs";

import { findStateRoot, fingerprint, readState, writeState } from "./orch.mjs";

// hooks.json の timeout(10秒) より手前で指紋の計算を切り上げる。間に合わなければ baseline は null で arm する
const FINGERPRINT_BUDGET_MS = 7 * 1000;
const COMMAND_PREFIX = "/orchestra:";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const deadline = Date.now() + FINGERPRINT_BUDGET_MS;
  const input = readStdin() ?? {};

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (prompt.trimStart().startsWith(COMMAND_PREFIX)) return;

  const root = findStateRoot(typeof input.cwd === "string" ? input.cwd : "");
  if (root === null) return;
  const state = readState(root);
  if (!state || state.active !== true || state.armed === true) return;

  writeState(root, {
    ...state,
    armed: true,
    armedAt: new Date().toISOString(),
    baseline: fingerprint(root, { deadline }),
  });
}

try {
  main();
} catch {
  /* プロンプト処理を妨げない */
}
process.exitCode = 0;
