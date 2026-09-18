import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { isWindowsCommandNotFound, runCommands } from "../scripts/stop-gate.mjs";

const FAIL = 'node -e "process.exit(1)"';
const PASS = 'node -e "process.exit(0)"';
const SLEEP = 'node -e "setTimeout(() => {}, 5000)"';

test("問題C: 予算が残っていれば pass / fail を判定する", async () => {
  const results = await runCommands([PASS, FAIL], process.cwd(), Date.now() + 60_000);
  assert.deepEqual(results.map((r) => r.status), ["pass", "fail"]);
});

test("問題C: 予算が尽きた後のコマンドは実行せず unavailable（時間切れ）にする", async () => {
  const results = await runCommands([FAIL, FAIL], process.cwd(), Date.now() - 1);
  assert.deepEqual(results.map((r) => r.status), ["unavailable", "unavailable"]);
  for (const r of results) assert.match(r.detail, /時間切れ/);
});

test("問題C: 各コマンドの timeout は残り予算で、超過後のコマンドは時間切れになる", async () => {
  const startedAt = Date.now();
  const results = await runCommands([SLEEP, FAIL], process.cwd(), startedAt + 1000);
  const elapsed = Date.now() - startedAt;

  assert.equal(results[0].status, "unavailable");
  assert.match(results[0].detail, /タイムアウト/);
  assert.equal(results[1].status, "unavailable");
  assert.match(results[1].detail, /時間切れ/);
  assert.ok(elapsed < 4000, `残り予算で打ち切られること (elapsed=${elapsed}ms)`);
});

test("レビュー5: 出力が上限を超えたコマンドは、理由を区別して unavailable にする", async () => {
  const noisy = `node -e "process.stdout.write('x'.repeat(17 * 1024 * 1024))"`;
  const [result] = await runCommands([noisy], process.cwd(), Date.now() + 60_000);
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /出力が上限/);
});

test("レビュー5: 失敗の抜粋は末尾40行で、stdout と stderr の両方を含む", async () => {
  const many = `node -e "for (let i = 1; i <= 60; i++) console.log('line' + i); console.error('ERR'); process.exit(1)"`;
  const [result] = await runCommands([many], process.cwd(), Date.now() + 60_000);
  assert.equal(result.status, "fail");
  const lines = result.detail.split("\n");
  assert.equal(lines.length, 40);
  assert.equal(lines.at(-1).trim(), "ERR");
  assert.ok(!result.detail.includes("line1\n"));
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM は「存在するが権限が無い」
    return error.code === "EPERM";
  }
}

test("残課題3: タイムアウト時は孫プロセスごと止める", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-tree-"));
  const pidFile = path.join(dir, "pids.txt");
  const readPids = () => {
    try {
      return fs.readFileSync(pidFile, "utf8").split(" ").map((pid) => Number.parseInt(pid, 10));
    } catch {
      return [];
    }
  };
  t.after(() => {
    // テストが失敗した場合でもプロセスを残さない。止めてからでないと、cwd を握られていて消せない
    for (const pid of readPids()) {
      if (isAlive(pid)) process.kill(pid);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // テストランナー役。孫（別の node）を起動して両方の PID を書き出し、自分も孫も長時間終わらない。
  // 孫は stdio を継承する（実際のテストランナーのワーカーと同じく、パイプを握ったまま残る）
  const script = path.join(dir, "runner.cjs");
  fs.writeFileSync(
    script,
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "inherit" });',
      "fs.writeFileSync(process.argv[2], process.pid + ' ' + child.pid);",
      "setTimeout(() => {}, 120000);",
    ].join("\n"),
    "utf8"
  );

  const startedAt = Date.now();
  const [result] = await runCommands([`node "${script}" "${pidFile}"`], dir, startedAt + 4000);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /タイムアウト/);
  assert.ok(elapsed < 15_000, `打ち切りに時間がかかりすぎていないこと (elapsed=${elapsed}ms)`);
  const pids = readPids();
  assert.equal(pids.length, 2, "timeout の前にランナーと孫プロセスが起動していること");

  // kill の反映には少し時間がかかるので、待ちながら確認する
  let alive = pids;
  for (let i = 0; i < 50 && alive.length > 0; i += 1) {
    alive = alive.filter(isAlive);
    if (alive.length > 0) await sleep(100);
  }
  assert.deepEqual(alive, [], "ランナー（子）と孫のどちらも残っていないこと");
});

// cmd.exe が実際に返すバイト列（CP932）。この環境で採取したもの
const CP932_NOT_FOUND = Buffer.concat([
  Buffer.from("'eslint' ", "latin1"),
  Buffer.from("82cd814193e095948352837d8393836882dc82bd82cd8a4f95948352837d8393836881410d0a", "hex"),
  Buffer.from("91808dec89c2945c82c88376838d834f8389838082dc82bd82cd836f8362836020837483408343", "hex"),
  Buffer.from("0d0a", "hex"),
]);
const ENGLISH_NOT_FOUND = Buffer.from(
  "'eslint' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
  "latin1"
);

test("問題Q: cmd.exe の未検出メッセージだけが stderr に出た exit 1 は未検出とみなす", () => {
  assert.equal(isWindowsCommandNotFound("eslint .", 1, CP932_NOT_FOUND), true);
  assert.equal(isWindowsCommandNotFound("eslint .", 1, ENGLISH_NOT_FOUND), true);
  assert.equal(
    isWindowsCommandNotFound("eslint .", 1, Buffer.from("'eslint' は、内部コマンドまたは外部コマンド、\r\n操作可能な…\r\n", "utf8")),
    true
  );
  assert.equal(isWindowsCommandNotFound("anything", 9009, Buffer.alloc(0)), true);
});

test("問題Q: 通常の失敗を未検出と誤判定しない", () => {
  // 出力なしの exit 1
  assert.equal(isWindowsCommandNotFound("eslint .", 1, Buffer.alloc(0)), false);
  // 未検出メッセージの後ろに他の出力が続く（テストランナーの中で起きた未検出など）
  const withExtra = Buffer.concat([ENGLISH_NOT_FOUND, Buffer.from("1 test failed\n", "latin1")]);
  assert.equal(isWindowsCommandNotFound("eslint .", 1, withExtra), false);
  // メッセージ中の名前が、実行したコマンドに含まれない（npm run の内側で起きた未検出など）
  assert.equal(isWindowsCommandNotFound("npm run lint", 1, ENGLISH_NOT_FOUND), false);
  // 終了コードが 1 / 9009 以外
  assert.equal(isWindowsCommandNotFound("eslint .", 2, ENGLISH_NOT_FOUND), false);
  // 文言が途中に現れるだけ
  const embedded = Buffer.from("error: 'eslint' is not recognized as an internal or external command,\r\n", "latin1");
  assert.equal(isWindowsCommandNotFound("eslint .", 1, embedded), false);
});
