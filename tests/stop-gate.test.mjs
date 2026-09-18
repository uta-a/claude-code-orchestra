import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createProject } from "./helpers.mjs";
import { writeState } from "../scripts/orch.mjs";

test("state が無ければ何もしない", (t) => {
  const p = createProject(t);
  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(p.runs(), 0);
  assert.equal(p.readState(), null);
});

test("active でなければ何もしない", (t) => {
  const p = createProject(t);
  p.start();
  const before = { ...p.readState(), active: false };
  fs.writeFileSync(path.join(p.root, ".orchestra", "state.json"), JSON.stringify(before), "utf8");
  p.change("edit");

  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(p.runs(), 0);
  assert.deepEqual(p.readState(), before);
});

test("問題A: 変更なし（指紋 === baseline）では検証せず、active のまま許可する", (t) => {
  const p = createProject(t);
  p.setResult("pass");
  p.start();

  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.blocked, false);
  assert.equal(r.stdout, "", "毎回の停止で出るので、ユーザー向けの通知は出さない");
  assert.match(r.stderr, /orchestra: まだ変更が無い/);
  assert.equal(p.runs(), 0, "検証コマンドを実行してはいけない");
  const state = p.readState();
  assert.equal(state.active, true, "計画承認待ちの停止でゲートが外れてはいけない");
  assert.equal(state.round, 0);
});

test("変更なしなら検証が fail する状態でも block しない", (t) => {
  const p = createProject(t);
  p.start();

  const r = p.gate();
  assert.equal(r.blocked, false);
  assert.equal(p.runs(), 0);
  assert.equal(p.readState().active, true);
});

test("変更あり＋検証 fail → block して round が増える", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.blocked, true);
  assert.match(r.reason, /verify: failed/);
  assert.equal(p.runs(), 1);
  const state = p.readState();
  assert.equal(state.active, true);
  assert.equal(state.round, 1);
  assert.equal(typeof state.lastFailFingerprint, "string");
});

test("block 後に変更なしで再度 Stop（stop_hook_active:true）→ 許可、active のまま", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");
  assert.equal(p.gate().blocked, true);
  const afterBlock = p.readState();

  const r = p.gate({ stop_hook_active: true });
  assert.equal(r.code, 0);
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: 前回の検証失敗から変更が無い/);
  assert.equal(p.runs(), 1, "再検証してはいけない");
  assert.deepEqual(p.readState(), afterBlock, "state を変更してはいけない");
});

test("問題B: block 後に変更あり＋まだ fail（stop_hook_active:true）→ 再び block", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit 1");
  assert.equal(p.gate().blocked, true);

  p.change("edit 2");
  const r = p.gate({ stop_hook_active: true });
  assert.equal(r.blocked, true, "stop_hook_active でも再検証して block する");
  assert.equal(p.runs(), 2);
  const state = p.readState();
  assert.equal(state.active, true);
  assert.equal(state.round, 2);
});

test("未追跡ファイルの追加も変更として検知する", (t) => {
  const p = createProject(t);
  p.start();
  fs.writeFileSync(path.join(p.root, "new-file.txt"), "new\n", "utf8");

  const r = p.gate();
  assert.equal(r.blocked, true);
  assert.equal(p.runs(), 1);
});

test("変更あり＋検証 pass → 許可して active:false", (t) => {
  const p = createProject(t);
  p.setResult("pass");
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.blocked, false);
  assert.equal(r.systemMessage, "orchestra: 検証を通過しました。検証ゲートを解除しました。");
  assert.equal(p.runs(), 1);
  const state = p.readState();
  assert.equal(state.active, false);
  assert.equal(typeof state.endedAt, "string");
});

test("block 後に修正して pass したら（stop_hook_active:true）許可して active:false", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit 1");
  assert.equal(p.gate().blocked, true);

  p.change("fix");
  p.setResult("pass");
  const r = p.gate({ stop_hook_active: true });
  assert.equal(r.blocked, false);
  assert.equal(p.runs(), 2);
  assert.equal(p.readState().active, false);
});

test("round が maxRounds に達したら許可して active:false", (t) => {
  const p = createProject(t);
  p.start(["--max-rounds", "2"]);

  p.change("edit 1");
  assert.equal(p.gate().blocked, true);
  p.change("edit 2");
  assert.equal(p.gate({ stop_hook_active: true }).blocked, true);
  assert.equal(p.readState().round, 2);

  p.change("edit 3");
  const r = p.gate({ stop_hook_active: true });
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: 周回上限 2/);
  assert.equal(p.runs(), 2, "上限到達後は検証しない");
  const state = p.readState();
  assert.equal(state.active, false);
  assert.equal(typeof state.endedAt, "string");
});

test("存在しないコマンドは unavailable で block しない", (t) => {
  const p = createProject(t, { commands: ["orchestra-no-such-command-xyz --check"] });
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: 検証できませんでした/);
  assert.match(r.systemMessage, /orchestra-no-such-command-xyz --check: コマンドが見つかりません/);
  assert.doesNotMatch(r.systemMessage, /通過/);
  assert.equal(p.readState().active, false);
});

test("存在しないコマンドがあっても、他の検証が fail なら block する", (t) => {
  const p = createProject(t);
  p.writeConfig({ commands: ["orchestra-no-such-command-xyz", p.verifyCommand] });
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.blocked, true);
  assert.doesNotMatch(r.reason, /orchestra-no-such-command-xyz/);
  assert.equal(p.readState().round, 1);
});

test("exit 1 で、stderr に未検出メッセージ風の文言を含むだけの失敗は fail として扱う", (t) => {
  const p = createProject(t);
  const script = path.join(p.tools, "noisy.cjs");
  fs.writeFileSync(
    script,
    [
      "console.error(\"'eslint' is not recognized as an internal or external command,\");",
      "console.error('operable program or batch file.');",
      "console.error('1 test failed');",
      "process.exit(1);",
    ].join("\n"),
    "utf8"
  );
  p.writeConfig({ commands: [`node "${script}"`] });
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.blocked, true);
});

test("検証コマンドが0件なら active:false にして許可する", (t) => {
  const p = createProject(t, { commands: null });
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: .*検証コマンドが見つからない/);
  assert.equal(p.readState().active, false);
});

// 指紋が取れない状況を作る。git 管理外にし、走査の上限を 1 件に下げて fs の指紋も諦めさせる
const NO_FINGERPRINT = { env: { ORCHESTRA_FS_MAX_ENTRIES: "1" } };

test("指紋が取れないときは stop_hook_active:true で許可する", (t) => {
  const p = createProject(t, { git: false });
  p.start([], NO_FINGERPRINT);
  const before = p.readState();
  assert.equal(before.armed, true);
  assert.equal(before.baseline, null);

  const r = p.gate({ stop_hook_active: true }, NO_FINGERPRINT);
  assert.equal(r.code, 0);
  assert.equal(r.blocked, false);
  assert.equal(p.runs(), 0);
  assert.deepEqual(p.readState(), before);
});

test("指紋が取れなくても stop_hook_active:false なら検証して block する", (t) => {
  const p = createProject(t, { git: false });
  p.start([], NO_FINGERPRINT);

  const r = p.gate({}, NO_FINGERPRINT);
  assert.equal(r.blocked, true);
  assert.equal(p.runs(), 1);
  const state = p.readState();
  assert.equal(state.round, 1);
  assert.equal(state.lastFailFingerprint, null);
});

test("問題S: input.cwd が別の場所でも CLAUDE_PROJECT_DIR の state を使う", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");

  const r = p.gate({ cwd: p.tools }, { cwd: p.tools, env: { CLAUDE_PROJECT_DIR: p.root } });
  assert.equal(r.blocked, true);
  assert.equal(p.readState().round, 1);
});

test("問題S: CLAUDE_PROJECT_DIR に state が無ければ input.cwd、次に process.cwd() を見る", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");

  const viaInput = p.gate({ cwd: p.root }, { cwd: p.tools, env: { CLAUDE_PROJECT_DIR: p.tools } });
  assert.equal(viaInput.blocked, true);

  p.change("edit 2");
  const viaProcess = p.gate({ cwd: p.tools }, { cwd: p.root });
  assert.equal(viaProcess.blocked, true);
  assert.equal(p.readState().round, 2);
});

test("state の書き込みに失敗したら block せず停止を許可する（fail open）", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");
  const dir = path.join(p.root, ".orchestra");
  const file = path.join(dir, "state.json");
  // Windows は読み取り専用ファイルへの rename が、POSIX は書き込み不可ディレクトリでの一時ファイル作成が失敗する
  fs.chmodSync(file, 0o444);
  fs.chmodSync(dir, 0o555);

  try {
    let writable = true;
    try {
      writeState(p.root, p.readState());
    } catch {
      writable = false;
    }
    if (writable) return t.skip("この環境では書き込み不可にできない（root 実行など）");

    const r = p.gate();
    assert.equal(r.code, 0);
    assert.equal(r.blocked, false);
    assert.match(r.systemMessage, /^orchestra: .*書き込め/);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "state.json"], "一時ファイルを残さない");
  } finally {
    // 後始末の rm が確実に通るよう、書き込み可能に戻す
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(file, 0o644);
  }
});

test("レビュー1: start 後に編集してコミットしても、変更ありとして検証する", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");
  p.git(["commit", "-q", "-am", "edit"]);

  const r = p.gate();
  assert.equal(r.blocked, true, "コミットで作業ツリーが clean に戻っても素通りさせない");
  assert.equal(p.runs(), 1);
  assert.equal(p.readState().round, 1);
});

test("レビュー2: 検証コマンドが作業ツリーに生成物を書いても、進捗なしガードが効く", (t) => {
  const p = createProject(t);
  const script = path.join(p.tools, "with-artifact.cjs");
  fs.writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'fs.appendFileSync(path.join(__dirname, "runs.log"), "run\\n");',
      'fs.writeFileSync(path.join(process.cwd(), "coverage.out"), String(Date.now()));',
      "process.exit(1);",
    ].join("\n"),
    "utf8"
  );
  p.writeConfig({ commands: [`node "${script}"`] });
  p.start();
  p.change("edit");
  assert.equal(p.gate().blocked, true);
  assert.equal(fs.existsSync(path.join(p.root, "coverage.out")), true);

  const r = p.gate({ stop_hook_active: true });
  assert.equal(r.blocked, false, "block 後に何も変更していない停止は許可する");
  assert.equal(p.runs(), 1, "再検証してはいけない");
  assert.equal(p.readState().round, 1);
});

test("レビュー3: start 後に .orchestra/config.json を書いただけでは変更とみなさない", (t) => {
  const p = createProject(t, { commands: null });
  p.setResult("pass");
  p.start();
  p.writeConfig({ commands: [p.verifyCommand] });

  const r = p.gate();
  assert.equal(r.blocked, false);
  assert.equal(p.runs(), 0);
  assert.equal(p.readState().active, true);
});

test("レビュー4: state.maxRounds が範囲外なら既定値で判定する", (t) => {
  const p = createProject(t);
  p.start();
  p.writeState({ ...p.readState(), maxRounds: 0 });
  p.change("edit");

  const r = p.gate();
  assert.equal(r.blocked, true, "maxRounds:0 で初回からゲートが外れてはいけない");
  assert.match(r.reason, /周回 1\/5/);
});

test("レビュー5: pass と unavailable が混じる場合は通過とし、実行不能を列挙する", (t) => {
  const p = createProject(t);
  p.setResult("pass");
  p.writeConfig({ commands: [p.verifyCommand, "orchestra-no-such-command-xyz"] });
  p.start();
  p.change("edit");

  const r = p.gate();
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: 検証を通過しました（ただし 1 件は実行不能）/);
  assert.match(r.systemMessage, /- orchestra-no-such-command-xyz: コマンドが見つかりません/);
  assert.equal(p.readState().active, false);
});

test("レビュー6: 指紋が取れず stop_hook_active により許可するときも通知する", (t) => {
  const p = createProject(t, { git: false });
  p.start([], NO_FINGERPRINT);
  assert.equal(p.gate({}, NO_FINGERPRINT).blocked, true);

  const r = p.gate({ stop_hook_active: true }, NO_FINGERPRINT);
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: 変更を検知できない/);
  assert.equal(p.runs(), 1);
  assert.equal(p.readState().active, true);
});

test("レビュー9: start から24時間を超えたゲートは、検証せず解除する", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  p.writeState({ ...p.readState(), startedAt: old });

  const r = p.gate();
  assert.equal(r.blocked, false);
  assert.match(r.systemMessage, /^orchestra: .*24時間/);
  assert.equal(p.runs(), 0);
  const state = p.readState();
  assert.equal(state.active, false);
  assert.equal(typeof state.endedAt, "string");
});

test("レビュー9: 24時間以内なら期限切れにしない", (t) => {
  const p = createProject(t);
  p.start();
  p.change("edit");
  const recent = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  p.writeState({ ...p.readState(), startedAt: recent });

  assert.equal(p.gate().blocked, true);
});

test("残課題1: arm 前（start 直後）は変更があっても検証せず、state も変えない", (t) => {
  const p = createProject(t);
  p.setResult("pass");
  p.orch(["start"]);
  const before = p.readState();
  assert.equal(before.armed, false);
  p.change("承認前の別作業");

  const r = p.gate();
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(p.runs(), 0, "承認待ちの停止で検証してはいけない");
  assert.deepEqual(p.readState(), before);
});

test("残課題1: git 管理外でも、arm 前の停止ではゲートが外れない", (t) => {
  const p = createProject(t, { git: false });
  p.setResult("pass");
  p.orch(["start"]);

  const r = p.gate();
  assert.equal(r.stdout, "");
  assert.equal(p.runs(), 0);
  assert.equal(p.readState().active, true);
});

test("残課題1: armed フィールドが無い旧形式の state は未 arm として扱う", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  const { armed, ...legacy } = p.readState();
  p.writeState(legacy);
  p.change("edit");

  assert.equal(p.gate().blocked, false);
  assert.equal(p.runs(), 0);
});

test("残課題1: arm 時に baseline を取り直すので、承認前の変更は「変更なし」の基準になる", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  const atStart = p.readState().baseline;
  p.change("承認前の別作業");
  p.arm("計画を修正してください");
  const state = p.readState();
  assert.equal(state.armed, true);
  assert.notEqual(state.baseline, atStart);

  // 修正依頼への応答で止まっただけ。変更が無いので検証しない
  const r = p.gate();
  assert.equal(r.blocked, false);
  assert.equal(p.runs(), 0);
  assert.equal(p.readState().active, true);

  // 実装が始まったら検証する
  p.change("実装");
  assert.equal(p.gate().blocked, true);
});

test("残課題1: 未 arm でも期限切れの判定は先に行う", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  p.writeState({ ...p.readState(), startedAt: old });

  const r = p.gate();
  assert.match(r.systemMessage, /^orchestra: .*24時間/);
  assert.equal(p.readState().active, false);
});

test("残課題2: git 管理外でも baseline 一致と進捗なしガードが効く", (t) => {
  const p = createProject(t, { git: false });
  p.start();
  assert.match(p.readState().baseline, /^fs:[0-9a-f]{64}$/);

  // 変更なし → 検証しない
  const idle = p.gate();
  assert.equal(idle.blocked, false);
  assert.equal(p.runs(), 0);
  assert.equal(p.readState().active, true);

  // 変更あり＋fail → block
  p.change("edit");
  assert.equal(p.gate().blocked, true);
  assert.match(p.readState().lastFailFingerprint, /^fs:[0-9a-f]{64}$/);

  // block 後に変更なし → 進捗なしガードで許可（stop_hook_active に頼らない）
  const report = p.gate({ stop_hook_active: true });
  assert.equal(report.blocked, false);
  assert.match(report.systemMessage, /^orchestra: 前回の検証失敗から変更が無い/);
  assert.equal(p.runs(), 1);

  // block 後に変更あり → stop_hook_active でも再検証して block
  p.change("edit 2");
  assert.equal(p.gate({ stop_hook_active: true }).blocked, true);
  assert.equal(p.readState().round, 2);
});
