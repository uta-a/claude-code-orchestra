import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ARM, createProject } from "./helpers.mjs";

/** どの場合も、プロンプト処理を妨げず（exit 0）、コンテキストに何も注入しない（stdout が空） */
function assertSilent(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

test("active かつ未 arm なら、ユーザーの発話で arm して baseline を取り直す", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  p.change("承認前の変更");

  assertSilent(p.arm("OK、その計画で進めてください"));
  const state = p.readState();
  assert.equal(state.armed, true);
  assert.equal(typeof state.armedAt, "string");
  assert.match(state.baseline, /^git:[0-9a-f]{64}$/);
  assert.equal(state.active, true);
  assert.equal(state.round, 0);
});

test("/orchestra: で始まるプロンプトでは arm しない", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  const before = p.readState();

  for (const prompt of ["/orchestra:run ログイン画面を直す", "/orchestra:plan", "  /orchestra:status"]) {
    assertSilent(p.arm(prompt));
    assert.deepEqual(p.readState(), before, prompt);
  }
});

test("arm 済みなら何もしない（baseline を取り直さない）", (t) => {
  const p = createProject(t);
  p.start();
  const before = p.readState();
  p.change("実装中の変更");

  assertSilent(p.arm("続けて"));
  assert.deepEqual(p.readState(), before);
});

test("state が無い、または active でないなら何もしない", (t) => {
  const p = createProject(t);
  assertSilent(p.arm());
  assert.equal(p.readState(), null);

  p.orch(["start"]);
  const inactive = { ...p.readState(), active: false };
  p.writeState(inactive);
  assertSilent(p.arm());
  assert.deepEqual(p.readState(), inactive);
});

test("input.cwd が別の場所でも CLAUDE_PROJECT_DIR の state を arm する", (t) => {
  const p = createProject(t);
  p.orch(["start"]);

  assertSilent(p.arm("OK", { cwd: p.tools, input: { cwd: p.tools }, env: { CLAUDE_PROJECT_DIR: p.root } }));
  assert.equal(p.readState().armed, true);
});

test("git 管理外でも arm し、fs の指紋を baseline にする", (t) => {
  const p = createProject(t, { git: false });
  p.orch(["start"]);

  assertSilent(p.arm());
  const state = p.readState();
  assert.equal(state.armed, true);
  assert.match(state.baseline, /^fs:[0-9a-f]{64}$/);
});

test("入力が JSON でなくても exit 0 で何も出さない", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  const r = spawnSync(process.execPath, [ARM], { cwd: p.root, env: p.env, input: "not json", encoding: "utf8" });
  assertSilent(r);
});

test("state に書き込めなくても exit 0 で何も出さない", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  const dir = path.join(p.root, ".orchestra");
  const file = path.join(dir, "state.json");
  fs.chmodSync(file, 0o444);
  fs.chmodSync(dir, 0o555);

  try {
    assertSilent(p.arm());
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(file, 0o644);
  }
});
