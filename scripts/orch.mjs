#!/usr/bin/env node
/**
 * orchestra のループ状態を管理する CLI。
 *
 *   node orch.mjs start [--max-rounds N]
 *   node orch.mjs stop
 *   node orch.mjs status
 *
 * 状態は <root>/.orchestra/state.json に置く。
 * start の root は CLAUDE_PROJECT_DIR があればそれ、無ければ cwd。
 * stop と status は Stop フックと同じ順（CLAUDE_PROJECT_DIR → cwd）で state.json を探す。
 * Stop フック(stop-gate.mjs)は、このファイルが active のときだけ検証ゲートを働かせる。
 * つまり /orchestra:run を使っていない通常のセッションでは、フックは何もしない。
 *
 * start の直後は未 arm（armed:false）で、Stop フックは検証しない。
 * ユーザーの次の発話で UserPromptSubmit フック(arm-gate.mjs)が arm し、そこから検証が働く。
 * 計画の承認待ちで止まっただけでゲートが外れるのを防ぐため。
 *
 * state の読み書き・設定の読み込み・検証コマンドの決定・作業ツリーの指紋は
 * ここに1つだけ置き、stop-gate.mjs と arm-gate.mjs はここから import する。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const STATE_DIR = ".orchestra";
export const STATE_FILE = "state.json";
export const CONFIG_FILE = "config.json";
export const DEFAULT_MAX_ROUNDS = 5;
export const MAX_ROUNDS_LIMIT = 20;
// 放置されたゲートの期限。start からこれを超えたら、Stop フックは検証せずに解除する
export const GATE_TTL_MS = 24 * 60 * 60 * 1000;

// 指紋は Stop フックの中で最大2回（検証の前後）取る。1回で git を4つ呼び、失敗すれば走査(FS_MAX_MS)に落ちる。
// 検証後の1回が最悪 45 秒かかっても、検証の時間予算(840秒)と合わせて hooks.json の timeout(900秒) に収まる長さにする
const GIT_TIMEOUT_MS = 10 * 1000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

// git で指紋が取れないときの走査の上限と、入らないディレクトリ
const FS_MAX_ENTRIES = 20000;
const FS_MAX_MS = 5 * 1000;
const FS_EXCLUDED_DIRS = new Set([".git", "node_modules", STATE_DIR]);

export function stateDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

export function statePath(cwd) {
  return path.join(stateDir(cwd), STATE_FILE);
}

export function configPath(cwd) {
  return path.join(stateDir(cwd), CONFIG_FILE);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readState(cwd) {
  return readJson(statePath(cwd), null);
}

/**
 * state を書く。同じディレクトリの一時ファイルに書いてから rename する（アトミック）。
 * 途中で失敗しても、既存の state.json が壊れた JSON になることはない。失敗は例外で知らせる。
 */
export function writeState(cwd, state) {
  fs.mkdirSync(stateDir(cwd), { recursive: true });
  const file = statePath(cwd);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* 一時ファイルを作る前に失敗した */
    }
    throw error;
  }
}

/** state を消す。無ければ何もしない。それ以外の失敗は例外で知らせる */
export function clearState(cwd) {
  try {
    fs.unlinkSync(statePath(cwd));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** 周回上限として受け付けるのは 1 以上 MAX_ROUNDS_LIMIT 以下の整数だけ。それ以外は fallback */
export function normalizeMaxRounds(value, fallback = DEFAULT_MAX_ROUNDS) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ROUNDS_LIMIT ? value : fallback;
}

export function readConfig(cwd) {
  const config = readJson(configPath(cwd), {}) ?? {};
  return {
    maxRounds: normalizeMaxRounds(config.maxRounds),
    commands: Array.isArray(config.commands) ? config.commands : null,
  };
}

/** config.json が存在するのに JSON として読めないとき true */
export function isConfigBroken(cwd) {
  let text;
  try {
    text = fs.readFileSync(configPath(cwd), "utf8");
  } catch {
    return false;
  }
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

/**
 * ルート候補。CLAUDE_PROJECT_DIR、フック入力の cwd、プロセスの cwd の順。
 * セッション中に cwd が変わっても state を見失わないようにする。
 */
export function rootCandidates(inputCwd) {
  return [process.env.CLAUDE_PROJECT_DIR, inputCwd, process.cwd()].filter(
    (dir) => typeof dir === "string" && dir !== ""
  );
}

/** state.json が存在する最初のルート候補。どこにも無ければ null */
export function findStateRoot(inputCwd) {
  return rootCandidates(inputCwd).find((dir) => fs.existsSync(statePath(dir))) ?? null;
}

export function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

/**
 * 検証コマンドの決定。
 * 1. .orchestra/config.json の commands
 * 2. package.json の scripts から順に拾う
 */
export function resolveCommands(cwd) {
  const config = readConfig(cwd);
  if (config.commands) {
    const commands = config.commands.filter((c) => typeof c === "string" && c.trim() !== "");
    if (commands.length > 0) return commands;
  }

  const pkg = readJson(path.join(cwd, "package.json"), null);
  if (!pkg || typeof pkg.scripts !== "object" || pkg.scripts === null) return [];

  const pm = detectPackageManager(cwd);
  const preferred = [
    ["typecheck", "type-check", "tsc"],
    ["lint"],
    ["test"],
  ];

  const commands = [];
  for (const group of preferred) {
    const found = group.find((name) => typeof pkg.scripts[name] === "string");
    if (found) commands.push(`${pm} run ${found}`);
  }
  return commands;
}

function git(cwd, args, deadline) {
  const timeout = Math.min(GIT_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) return null;
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    timeout,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/**
 * git による指紋。git rev-parse HEAD、git status --porcelain、git diff HEAD の出力と、
 * 未追跡ファイルの size と mtimeMs を連結して sha256 する。
 * git 管理外、コミットが1つも無い、git コマンドの失敗・タイムアウトでは null。
 *
 * HEAD を含めるのは、編集してコミットすると作業ツリーが clean に戻り、
 * status と diff だけでは「変更なし」に見えてしまうため。
 */
function gitFingerprint(cwd, deadline) {
  const pathspec = ["--", ":/", `:(exclude)${STATE_DIR}`];

  const head = git(cwd, ["rev-parse", "HEAD"], deadline);
  if (head === null) return null;
  const status = git(cwd, ["status", "--porcelain", ...pathspec], deadline);
  if (status === null) return null;
  const diff = git(cwd, ["diff", "HEAD", ...pathspec], deadline);
  if (diff === null) return null;
  const others = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec], deadline);
  if (others === null) return null;

  const hash = crypto.createHash("sha256");
  hash.update(head);
  hash.update("\0");
  hash.update(status);
  hash.update("\0");
  hash.update(diff);
  hash.update("\0");
  for (const file of others.toString("utf8").split("\0")) {
    if (file === "") continue;
    let stat = "missing";
    try {
      const s = fs.statSync(path.join(cwd, file));
      stat = `${s.size}:${s.mtimeMs}`;
    } catch {
      /* 列挙と stat の間に消えた */
    }
    hash.update(`${file}\0${stat}\0`);
  }
  return `git:${hash.digest("hex")}`;
}

/** テストから走査の上限を下げるための口。巨大なツリーを実際に作らずに「指紋なし」の経路を通す */
function fsMaxEntriesFromEnv() {
  const value = Number.parseInt(process.env.ORCHESTRA_FS_MAX_ENTRIES ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : FS_MAX_ENTRIES;
}

/**
 * git が使えないときの指紋。ルート配下を走査し、「相対パス・size・mtimeMs」を sha256 する。
 * - .git / node_modules / .orchestra という名前のディレクトリには入らない
 * - シンボリックリンクは辿らない（リンク自体を1エントリとして扱う）
 * - 読めないエントリは飛ばす
 * - 走査順に依存しないよう、パスでソートしてからハッシュする
 * - エントリ数か走査時間の上限を超えたら null（ホームディレクトリ直下などで延々と走査しない）
 */
export function fsFingerprint(root, options = {}) {
  const maxEntries = options.maxEntries ?? fsMaxEntriesFromEnv();
  const limitAt = Math.min(Date.now() + (options.maxMs ?? FS_MAX_MS), options.deadline ?? Infinity);

  const records = [];
  const pending = [""];
  let count = 0;
  while (pending.length > 0) {
    const rel = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      if (rel === "") return null;
      continue;
    }
    for (const entry of entries) {
      count += 1;
      if (count > maxEntries || Date.now() > limitAt) return null;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      // リンク先がディレクトリでも isDirectory() は false なので、リンクの先には入らない
      if (entry.isDirectory()) {
        if (!FS_EXCLUDED_DIRS.has(entry.name)) pending.push(childRel);
        continue;
      }
      try {
        const s = fs.lstatSync(path.join(root, childRel));
        records.push(`${childRel}\0${s.size}:${s.mtimeMs}`);
      } catch {
        /* 読めないエントリは飛ばす */
      }
    }
  }

  records.sort();
  const hash = crypto.createHash("sha256");
  for (const record of records) hash.update(`${record}\0`);
  return `fs:${hash.digest("hex")}`;
}

/**
 * 作業ツリーの指紋。「arm のあと何か変更されたか」「block のあと何か変更されたか」の判定に使う。
 * まず git で取り、取れなければルート配下の走査に落ちる。どちらも取れなければ null（変更検知できない）。
 * 種別の違う指紋が等しいと判定されないよう、`git:` / `fs:` の接頭辞を付ける。
 *
 * どちらの方式でも .orchestra/ は対象から外す。state.json はゲートが自分で書き換えるファイルで、
 * config.json は start の警告に従ってあとから書かれることがある。
 *
 * options.deadline（epoch ms）を渡すと、その時刻までに終わらせる（UserPromptSubmit フック用）。
 */
export function fingerprint(cwd, options = {}) {
  const deadline = options.deadline ?? Infinity;
  return gitFingerprint(cwd, deadline) ?? fsFingerprint(cwd, { deadline });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-rounds") out.maxRounds = Number.parseInt(argv[++i] ?? "", 10);
  }
  return out;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const cwd = rootCandidates()[0];
  const args = parseArgs(rest);
  const config = readConfig(cwd);

  if (command === "start") {
    const maxRounds = normalizeMaxRounds(args.maxRounds, config.maxRounds);
    writeState(cwd, {
      active: true,
      round: 0,
      maxRounds,
      // ユーザーの次の発話（UserPromptSubmit フックの arm-gate.mjs）までは未 arm。
      // 未 arm の間、Stop フックは検証しない。baseline は arm のときに取り直す
      armed: false,
      baseline: fingerprint(cwd),
      startedAt: new Date().toISOString(),
    });
    console.log(`orchestra: 検証ゲートを有効化しました (周回上限 ${maxRounds})`);
    if (isConfigBroken(cwd)) {
      console.log(
        "orchestra: 警告: .orchestra/config.json を JSON として読めません。設定は無視されます"
      );
    }

    const commands = resolveCommands(cwd);
    if (commands.length === 0) {
      console.log(
        "orchestra: 警告: 検証コマンドが見つからないためゲートは効かない。" +
          ".orchestra/config.json に commands を書くこと"
      );
    } else {
      console.log("orchestra: ゲートが使う検証コマンド:");
      for (const c of commands) console.log(`  - ${c}`);
    }
    return;
  }

  if (command === "stop") {
    // Stop フックと同じ探し方をする。フックが見ている state を消さないと解除にならない
    const root = findStateRoot();
    if (root === null) {
      console.log("orchestra: 有効なゲートはありません");
      return;
    }
    try {
      clearState(root);
    } catch (error) {
      console.error(`orchestra: 検証ゲートを解除できませんでした: ${error?.message ?? error}`);
      process.exitCode = 1;
      return;
    }
    console.log("orchestra: 検証ゲートを解除しました");
    return;
  }

  if (command === "status") {
    const root = findStateRoot();
    const state = root === null ? null : readState(root);
    if (!state || !state.active) {
      console.log("orchestra: 検証ゲートは無効です");
      return;
    }
    const armed = state.armed === true ? "済み" : "未（ユーザーの次の発話で arm され、それまで検証しない）";
    console.log(
      `orchestra: 有効 / arm: ${armed} / 周回 ${state.round}/${state.maxRounds} / 開始 ${state.startedAt}`
    );
    return;
  }

  console.error("usage: orch.mjs <start|stop|status> [--max-rounds <n>]");
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "orch.mjs"));

if (invokedDirectly) {
  main();
}
