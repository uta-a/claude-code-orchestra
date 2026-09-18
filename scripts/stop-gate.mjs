#!/usr/bin/env node
/**
 * Stop フック: 検証が通るまでセッションを完了させない。
 *
 * 設計上の要点
 * 1. .orchestra/state.json が active のときだけ働く。通常セッションでは何もしない。
 * 2. start の直後は未 arm で、検証しない。ユーザーの次の発話で arm-gate.mjs が arm する。
 *    arm 時点から作業ツリーが変わっていなければ、検証もせずゲートも外さない。
 *    （計画の承認待ちで止まっただけで、未変更のコードが検証を通ってゲートが外れるのを防ぐ）
 * 3. ループ防止の主役は周回カウンタ。上限に達したら block をやめて人間に返す（予算カウンタ）。
 *    stop_hook_active が true でも、ゲートが有効なら再検証する。
 * 4. block のあと何も変更されていない停止は「報告のための停止」とみなして許可する（進捗なしガード）。
 *    指紋が取れず変更検知ができないときだけ、stop_hook_active で抜ける。
 * 5. 「検証コマンドが存在しない・起動できない」は失敗として扱わない。
 *    インフラ由来の失敗で block し続けると、何も進まないままトークンだけ消える。
 * 6. state を書けないときは必ず停止を許可する（fail open）。
 *    カウンタが進まないまま block し続けるのを防ぐ。
 * 7. start から24時間を超えた放置ゲートは、検証せずに解除する。
 * 8. ユーザーに知らせるべき許可（解除、進捗なしガード、書き込み失敗）は stdout の systemMessage で伝える。
 *    stderr + exit 0 はユーザーに表示されない。毎回の停止で通る「まだ変更が無い」だけは stderr のままにする。
 * 9. 検証コマンドがタイムアウトしたら、プロセスツリーごと止める（シェルだけ止めてもテストランナーが残る）。
 *
 * 判定順: active 確認 → 期限切れ → arm 確認 → 指紋 → baseline 一致 → 周回上限 → 進捗なしガード → コマンド決定 → 実行
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  GATE_TTL_MS,
  findStateRoot,
  fingerprint,
  normalizeMaxRounds,
  readState,
  resolveCommands,
  writeState,
} from "./orch.mjs";

// hooks.json の timeout(900秒) より手前で自分から切り上げる。全コマンド合計の予算。
const TOTAL_BUDGET_MS = 840 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// ツリーを止めたあと、パイプが閉じるのを待つ上限
const KILL_GRACE_MS = 5 * 1000;
const TASKKILL_TIMEOUT_MS = 10 * 1000;

// cmd.exe の「コマンドが見つからない」メッセージの一部。
// stderr はコンソールのコードページ（日本語環境では CP932）で返り、utf8 として読むと文字化けする。
// デコードに頼らず、バイト列のまま照合する。
const CMD_NOT_FOUND_MARKERS = [
  Buffer.from("is not recognized as an internal or external command", "latin1"),
  // 「内部コマンドまたは外部コマンド」の CP932 表現
  Buffer.from("93e095948352837d8393836882dc82bd82cd8a4f95948352837d83938368", "hex"),
  // 同じ文言の UTF-8 表現（chcp 65001 の場合）
  Buffer.from("内部コマンドまたは外部コマンド", "utf8"),
];

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function trimNewlines(buffer) {
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
  return buffer.subarray(0, end);
}

/**
 * Windows(cmd.exe) での「コマンドが見つからない」の判定。
 *
 * cmd /c は未検出でも exit 1 を返すので、終了コードだけでは通常のテスト失敗と区別できない。
 * 誤って失敗を見逃さないよう、次をすべて満たすときだけ未検出とみなす。
 * - stderr 全体が cmd.exe の未検出メッセージ（2行）だけである
 * - メッセージ中の 'name' が、実行しようとしたコマンド文字列に含まれている
 * 9009 は、バッチが未検出の errorlevel をそのまま返した場合の終了コード。
 */
export function isWindowsCommandNotFound(command, status, stderr) {
  if (status === 9009) return true;
  if (status !== 1 || !Buffer.isBuffer(stderr)) return false;

  const text = trimNewlines(stderr);
  if (text.length === 0 || text[0] !== 0x27) return false;

  const lines = [];
  let from = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === 0x0a) {
      lines.push(text.subarray(from, i));
      from = i + 1;
    }
  }
  if (lines.length > 2) return false;

  const first = lines[0];
  const quoteEnd = first.indexOf(0x27, 1);
  if (quoteEnd <= 1) return false;
  const nameBytes = first.subarray(1, quoteEnd);
  // 非 ASCII の名前はコードページ依存で照合できないので、対象外（fail 扱い）にする
  if (nameBytes.some((b) => b < 0x20 || b > 0x7e)) return false;
  if (!command.includes(nameBytes.toString("latin1"))) return false;

  const rest = first.subarray(quoteEnd + 1);
  return CMD_NOT_FOUND_MARKERS.some((marker) => rest.includes(marker));
}

/**
 * プロセスツリーごと止める。
 * shell:true で起動しているので、child はシェル（cmd.exe / sh）で、テストランナーはその子や孫にいる。
 * child.kill() ではシェルしか止まらず、ランナーが残り続ける。
 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error) child.kill();
    return;
  }
  try {
    // detached:true で起動しているので、child はプロセスグループのリーダー。負の pid でグループ全体に送る
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** 終了したコマンドの結果を pass / fail / unavailable に分類する */
function classify(command, outcome) {
  if (outcome.aborted === "timeout") {
    return { status: "unavailable", detail: "タイムアウトしました" };
  }
  if (outcome.aborted === "overflow") {
    return { status: "unavailable", detail: `出力が上限（${MAX_OUTPUT_BYTES / 1024 / 1024}MB）を超えたため打ち切りました` };
  }
  if (outcome.error) {
    return { status: "unavailable", detail: String(outcome.error.message ?? outcome.error) };
  }
  // シェルが「コマンドが見つからない」を返した場合は検証不能として扱う
  if (outcome.code === 127) {
    return { status: "unavailable", detail: "コマンドが見つかりません" };
  }
  if (process.platform === "win32" && isWindowsCommandNotFound(command, outcome.code, outcome.stderr)) {
    return { status: "unavailable", detail: "コマンドが見つかりません" };
  }
  if (outcome.code === 0) {
    return { status: "pass", detail: "" };
  }

  const output = `${outcome.stdout.toString("utf8")}\n${outcome.stderr.toString("utf8")}`.trim();
  const tail = output.split("\n").slice(-40).join("\n");
  return { status: "fail", detail: tail };
}

/**
 * 検証コマンドを1つ実行する。
 * タイムアウトでツリーごと止められるよう、spawnSync ではなく非同期の spawn を使う。
 * stdout / stderr は Buffer のまま集める（Windows の未検出判定がバイト列で照合するため）。
 */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let aborted = null;
    let settled = false;
    let timer = null;
    let graceTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(
        classify(command, {
          aborted,
          stdout: Buffer.concat(chunks.stdout),
          stderr: Buffer.concat(chunks.stderr),
          ...result,
        })
      );
    };

    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return finish({ error });
    }

    const abort = (why) => {
      if (aborted !== null || settled) return;
      aborted = why;
      killTree(child);
      // 止めきれなかったプロセスがパイプを握っていると close が来ない。待ち続けない
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: null });
      }, KILL_GRACE_MS);
    };

    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (aborted !== null) return;
        sizes[name] += chunk.length;
        if (sizes[name] > MAX_OUTPUT_BYTES) return abort("overflow");
        chunks[name].push(chunk);
      });
    }

    timer = setTimeout(() => abort("timeout"), timeoutMs);
    child.on("error", (error) => finish({ error }));
    child.on("close", (code) => finish({ code }));
  });
}

/**
 * コマンドを直列に実行する。各コマンドの timeout は deadline までの残り時間。
 * 予算が尽きた後のコマンドは実行せず unavailable にする。
 */
export async function runCommands(commands, cwd, deadline) {
  const results = [];
  for (const command of commands) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ command, status: "unavailable", detail: "時間切れ（検証全体の時間予算を使い切りました）" });
      continue;
    }
    results.push({ command, ...(await runCommand(command, cwd, remaining)) });
  }
  return results;
}

/** 停止を許可する。message は stderr に書くだけで、ユーザーには見えない前提（毎回出る静かな許可に使う） */
function allowStop(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(0);
}

/** 停止を許可し、ユーザーに知らせる。stderr + exit 0 は表示されないので、stdout の systemMessage で伝える */
function notifyStop(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
  process.exit(0);
}

function blockStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

/** state を書く。失敗しても例外にせず false を返す（呼び出し側は必ず停止を許可する） */
function saveState(root, state) {
  try {
    writeState(root, state);
    return true;
  } catch {
    return false;
  }
}

const RELEASE_FAILED_NOTE =
  "orchestra: ただし state.json に書き込めなかったため、ゲートは有効のままです。/orchestra:off で解除してください。";

function isExpired(state) {
  const startedAt = Date.parse(state.startedAt);
  return Number.isFinite(startedAt) && Date.now() - startedAt > GATE_TTL_MS;
}

function listUnavailable(unavailable) {
  return unavailable.map((u) => `- ${u.command}: ${u.detail}`).join("\n");
}

async function main() {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const input = readStdin();

  // 1. ゲートが有効（active）でなければ何もしない
  const root = findStateRoot(typeof input.cwd === "string" ? input.cwd : "");
  if (root === null) return allowStop();
  const state = readState(root);
  if (!state || state.active !== true) return allowStop();

  const round = Number.isInteger(state.round) ? state.round : 0;
  const maxRounds = normalizeMaxRounds(state.maxRounds);

  const release = (message) => {
    const saved = saveState(root, { ...state, active: false, endedAt: new Date().toISOString() });
    return notifyStop(saved ? message : `${message}\n${RELEASE_FAILED_NOTE}`);
  };

  // 2. 放置されたゲートは検証せずに解除する（別の作業の停止を、古いゲートが block しないように）
  if (isExpired(state)) {
    return release(
      `orchestra: 検証ゲートの開始から${GATE_TTL_MS / 3600000}時間を超えたため、検証せずに解除しました。` +
        "続ける場合は /orchestra:run をやり直してください。"
    );
  }

  // 3. 未 arm の間は何もしない。start のあと、ユーザーの次の発話で arm-gate.mjs が arm する。
  //    計画の承認待ちの停止で検証が走り、実装前にゲートが外れるのを防ぐ。
  //    armed フィールドが無い旧形式の state も未 arm として扱う
  if (state.armed !== true) return allowStop();

  // 4. 作業ツリーの指紋。git でも走査でも取れなければ null
  const current = fingerprint(root);

  // 5. arm から何も変更されていない。検証せず、ゲートも外さない
  //    修正依頼への応答など毎回の停止で通る道なので、ユーザーへの通知は出さない
  if (current !== null && current === state.baseline) {
    return allowStop("orchestra: まだ変更が無いため検証せず、ゲートは維持します。");
  }

  // 6. 周回上限に達していたら人間に返す
  if (round >= maxRounds) {
    return release(
      `orchestra: 周回上限 ${maxRounds} に達したため検証ゲートを解除しました。残課題は人間が判断してください。`
    );
  }

  // 7. 進捗なしガード。block のあと何も変更されていない停止は、報告のための停止とみなす
  if (current !== null && current === state.lastFailFingerprint) {
    return notifyStop(
      "orchestra: 前回の検証失敗から変更が無いため再検証せず、ゲートは維持します（検証は失敗したままです）。"
    );
  }
  // 変更検知ができないときだけ、stop_hook_active で抜ける（無限ループ防止を優先）
  if (current === null && input.stop_hook_active === true) {
    return notifyStop(
      "orchestra: 変更を検知できないため再検証せず、停止を許可します。ゲートは維持します（検証が通ったとは限りません）。"
    );
  }

  // 8. 検証コマンドの決定
  const commands = resolveCommands(root);
  if (commands.length === 0) {
    return release(
      "orchestra: 実行できる検証コマンドが見つからないため、ゲートを解除しました。" +
        ".orchestra/config.json の commands に検証コマンドを指定してください。"
    );
  }

  // 9. 実行
  const results = await runCommands(commands, root, deadline);
  const failures = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass");
  const unavailable = results.filter((r) => r.status === "unavailable");

  if (failures.length === 0 && passed.length === 0) {
    // 1つも実行できていないのに「通過」とは言わない
    return release(
      "orchestra: 検証できませんでした（実行できたコマンドがありません）。検証ゲートを解除しました。\n" +
        listUnavailable(unavailable)
    );
  }

  if (failures.length === 0) {
    const note = unavailable.length
      ? `orchestra: 検証を通過しました（ただし ${unavailable.length} 件は実行不能）。検証ゲートを解除しました。\n` +
        listUnavailable(unavailable)
      : "orchestra: 検証を通過しました。検証ゲートを解除しました。";
    return release(note);
  }

  // 失敗したので周回を進めて block する。周回を記録できないなら block しない。
  // 指紋は検証のあとで取り直す。検証コマンドが作業ツリーに生成物（coverage など）を書くと、
  // 検証前の指紋では次の停止で「変更あり」に見えてしまい、進捗なしガードが効かない。
  const saved = saveState(root, { ...state, round: round + 1, lastFailFingerprint: fingerprint(root) });
  if (!saved) {
    return notifyStop(
      "orchestra: state.json に書き込めませんでした。" +
        "検証は失敗していますが、周回を記録できないため停止を許可します。"
    );
  }

  const detail = failures
    .map((f) => `- ${f.command}\n${f.detail || "(出力なし)"}`)
    .join("\n\n");

  const reason = [
    `検証が失敗しています（周回 ${round + 1}/${maxRounds}）。完了する前に修正してください。`,
    "",
    detail,
    "",
    "手順:",
    "1. 失敗の原因を特定する",
    "2. orchestra:implementer に修正を委譲する",
    "3. orchestra:verifier に再検証を委譲する",
    "",
    "テストやコードを書き換えて通すことは禁止です。",
    "検証コマンド自体が壊れている場合は、修正せずにその旨を報告して停止してください。",
  ].join("\n");

  return blockStop(reason);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "stop-gate.mjs"));

if (invokedDirectly) {
  main();
}
