/**
 * テスト共通の道具。
 *
 * 一時ディレクトリの構成:
 *   <base>/repo   … 検証対象のプロジェクトルート（.orchestra/ を置く場所）
 *   <base>/tools  … 検証コマンドの実体。repo の外に置き、実行記録が作業ツリーの指紋に影響しないようにする
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ORCH = path.join(here, "..", "scripts", "orch.mjs");
export const GATE = path.join(here, "..", "scripts", "stop-gate.mjs");
export const ARM = path.join(here, "..", "scripts", "arm-gate.mjs");

// 結果ファイル(pass/fail)に従って終了し、実行されるたびに runs.log に1行足す検証スクリプト
const VERIFY_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "runs.log"), "run\\n");
const result = fs.readFileSync(path.join(__dirname, "result"), "utf8").trim();
if (result !== "pass") {
  console.error("verify: failed");
  process.exit(1);
}
`;

/**
 * 一時プロジェクトを作る。t.after で必ず後始末する。
 * @param {import("node:test").TestContext} t
 * @param {{ git?: boolean, commands?: string[] | null }} options
 */
export function createProject(t, { git = true, commands } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const root = path.join(base, "repo");
  const tools = path.join(base, "tools");
  fs.mkdirSync(path.join(root, ".orchestra"), { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "verify.cjs"), VERIFY_SOURCE, "utf8");
  fs.writeFileSync(path.join(root, "app.txt"), "initial\n", "utf8");

  // 親ディレクトリの環境に左右されないようにする
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: base };
  delete env.CLAUDE_PROJECT_DIR;

  const project = {
    base,
    root,
    tools,
    env,
    verifyCommand: `node "${path.join(tools, "verify.cjs")}"`,
    setResult(result) {
      fs.writeFileSync(path.join(tools, "result"), result, "utf8");
    },
    runs() {
      try {
        return fs.readFileSync(path.join(tools, "runs.log"), "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
    writeConfig(config) {
      fs.writeFileSync(path.join(root, ".orchestra", "config.json"), JSON.stringify(config, null, 2), "utf8");
    },
    writeState(state) {
      fs.writeFileSync(path.join(root, ".orchestra", "state.json"), JSON.stringify(state, null, 2), "utf8");
    },
    readState() {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, ".orchestra", "state.json"), "utf8"));
      } catch {
        return null;
      }
    },
    /** 追跡対象のファイルを書き換えて「変更あり」にする */
    change(text) {
      fs.appendFileSync(path.join(root, "app.txt"), `${text}\n`, "utf8");
    },
    git(args) {
      const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    },
    orch(args, extra = {}) {
      return spawnSync(process.execPath, [ORCH, ...args], {
        cwd: extra.cwd ?? root,
        env: { ...env, ...(extra.env ?? {}) },
        encoding: "utf8",
      });
    },
    /** UserPromptSubmit フックを起動する（ユーザーの発話）。stdout には何も出ないのが正しい */
    arm(prompt = "OK、進めてください", extra = {}) {
      return spawnSync(process.execPath, [ARM], {
        cwd: extra.cwd ?? root,
        env: { ...env, ...(extra.env ?? {}) },
        input: JSON.stringify({ cwd: root, prompt, ...(extra.input ?? {}) }),
        encoding: "utf8",
      });
    },
    /** ゲートを有効化し、ユーザーの次の発話まで進めた状態（arm 済み）にする */
    start(args = [], extra = {}) {
      const started = project.orch(["start", ...args], extra);
      project.arm(undefined, extra);
      return started;
    },
    /**
     * Stop フックを起動する。stdout は空か、JSON 1個のどちらか。
     * blocked は decision から判定し、ユーザー向けの通知は systemMessage で受け取る
     */
    gate(input = {}, extra = {}) {
      const result = spawnSync(process.execPath, [GATE], {
        cwd: extra.cwd ?? root,
        env: { ...env, ...(extra.env ?? {}) },
        input: JSON.stringify({ cwd: root, stop_hook_active: false, ...input }),
        encoding: "utf8",
      });
      let output = null;
      if (result.stdout.trim()) output = JSON.parse(result.stdout);
      return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        blocked: output?.decision === "block",
        reason: output?.reason ?? "",
        systemMessage: output?.systemMessage ?? "",
      };
    },
  };

  project.setResult("fail");
  project.writeConfig({ commands: commands === undefined ? [project.verifyCommand] : commands ?? undefined });

  if (git) {
    const run = project.git;
    run(["init", "-q"]);
    run(["config", "user.name", "orchestra-test"]);
    run(["config", "user.email", "orchestra-test@example.invalid"]);
    run(["config", "core.autocrlf", "false"]);
    run(["config", "commit.gpgsign", "false"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);
  }

  return project;
}
