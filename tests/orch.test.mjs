import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createProject } from "./helpers.mjs";
import {
  DEFAULT_MAX_ROUNDS,
  detectPackageManager,
  fingerprint,
  fsFingerprint,
  normalizeMaxRounds,
  writeState,
} from "../scripts/orch.mjs";

/** このプロセス内で fingerprint を呼ぶとき、git が一時ディレクトリの外のリポジトリを拾わないようにする */
function useCeiling(t, base) {
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = base;
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = saved;
  });
}

test("start は baseline を記録し、ゲートが使う検証コマンドを表示する", (t) => {
  const p = createProject(t);
  const r = p.orch(["start"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /orchestra: 検証ゲートを有効化しました \(周回上限 5\)/);
  assert.match(r.stdout, /ゲートが使う検証コマンド/);
  assert.ok(r.stdout.includes(p.verifyCommand));

  const state = p.readState();
  assert.equal(state.active, true);
  assert.equal(state.round, 0);
  assert.equal(state.maxRounds, 5);
  assert.match(state.baseline, /^git:[0-9a-f]{64}$/);
});

test("残課題1: start は未 arm で作り、status は arm 済みかどうかを表示する", (t) => {
  const p = createProject(t);
  p.orch(["start"]);
  assert.equal(p.readState().armed, false);
  assert.match(p.orch(["status"]).stdout, /orchestra: 有効 \/ arm: 未/);

  p.arm();
  assert.match(p.orch(["status"]).stdout, /orchestra: 有効 \/ arm: 済み/);
});

test("start は検証コマンドが0件なら警告する", (t) => {
  const p = createProject(t, { commands: null });
  const r = p.orch(["start"]);
  assert.match(r.stdout, /検証コマンドが見つからないためゲートは効かない。\.orchestra\/config\.json に commands を書くこと/);
});

test("start は package.json の scripts から検証コマンドを決める（bun.lock は bun）", (t) => {
  const p = createProject(t, { commands: null });
  fs.writeFileSync(
    path.join(p.root, "package.json"),
    JSON.stringify({ scripts: { lint: "x", test: "y" } }),
    "utf8"
  );
  fs.writeFileSync(path.join(p.root, "bun.lock"), "", "utf8");

  const r = p.orch(["start"]);
  assert.match(r.stdout, /- bun run lint/);
  assert.match(r.stdout, /- bun run test/);
  assert.equal(detectPackageManager(p.root), "bun");
});

test("問題D: --task は未知のオプションとして値ごと無視し、state にも status にも出さない", (t) => {
  const p = createProject(t);
  p.orch(["start", "--task", "secret task text", "--max-rounds", "3"]);
  const state = p.readState();
  assert.equal("task" in state, false);
  assert.equal(state.maxRounds, 3);

  const status = p.orch(["status"]);
  assert.match(status.stdout, /orchestra: 有効 \/ .*周回 0\/3/);
  assert.doesNotMatch(status.stdout, /secret task text/);
});

test("未知のオプションの値が --max-rounds でも、オプションとして解釈される（位置では判断しない）", (t) => {
  const p = createProject(t);
  // parseArgs は未知のオプションを1語ずつ読み飛ばすだけで、その値を消費しない
  p.orch(["start", "--task", "--max-rounds", "2"]);
  assert.equal(p.readState().maxRounds, 2);
});

test("問題S: CLAUDE_PROJECT_DIR があれば cwd より優先する", (t) => {
  const p = createProject(t);
  p.orch(["start"], { cwd: p.tools, env: { CLAUDE_PROJECT_DIR: p.root } });
  assert.equal(p.readState().active, true);
  assert.equal(fs.existsSync(path.join(p.tools, ".orchestra")), false);

  p.orch(["stop"], { cwd: p.tools, env: { CLAUDE_PROJECT_DIR: p.root } });
  assert.equal(p.readState(), null);
});

test("fingerprint は state.json の書き換えでは変わらず、作業ツリーの変更で変わる", (t) => {
  const p = createProject(t);
  useCeiling(t, p.base);

  const before = fingerprint(p.root);
  assert.match(before, /^git:[0-9a-f]{64}$/);

  p.orch(["start"]);
  assert.equal(fingerprint(p.root), before, "state.json は指紋の対象外");

  p.change("edit");
  const edited = fingerprint(p.root);
  assert.notEqual(edited, before);

  fs.writeFileSync(path.join(p.root, "untracked.txt"), "a", "utf8");
  const untracked = fingerprint(p.root);
  assert.notEqual(untracked, edited);

  // 同じサイズのまま内容だけ変えても、mtime で検知する
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(path.join(p.root, "untracked.txt"), "b", "utf8");
  fs.utimesSync(path.join(p.root, "untracked.txt"), later, later);
  assert.notEqual(fingerprint(p.root), untracked);
});

test("残課題2: fingerprint は git 管理外なら fs の走査による指紋に落ちる", (t) => {
  const p = createProject(t, { git: false });
  useCeiling(t, p.base);

  const before = fingerprint(p.root);
  assert.match(before, /^fs:[0-9a-f]{64}$/);
  assert.equal(fingerprint(p.root), before, "変更が無ければ同じ");

  p.change("edit");
  assert.notEqual(fingerprint(p.root), before);
});

test("残課題2: fingerprint はコミットが1つも無いリポジトリでも fs の指紋に落ちる", (t) => {
  const p = createProject(t, { git: false });
  useCeiling(t, p.base);
  p.git(["init", "-q"]);
  assert.match(fingerprint(p.root), /^fs:/);
});

test("残課題2: fsFingerprint は .git / node_modules / .orchestra を無視する", (t) => {
  const p = createProject(t, { git: false });
  const before = fsFingerprint(p.root);

  for (const dir of [".git", "node_modules", path.join("sub", "node_modules"), ".orchestra"]) {
    fs.mkdirSync(path.join(p.root, dir), { recursive: true });
    fs.writeFileSync(path.join(p.root, dir, "noise.txt"), "x", "utf8");
  }
  assert.equal(fsFingerprint(p.root), before);

  fs.writeFileSync(path.join(p.root, "sub", "real.txt"), "x", "utf8");
  assert.notEqual(fsFingerprint(p.root), before, "除外対象でないファイルの追加は検知する");
});

test("残課題2: fsFingerprint は size と mtime の変化、削除を検知する", (t) => {
  const p = createProject(t, { git: false });
  const file = path.join(p.root, "app.txt");
  const initial = fsFingerprint(p.root);

  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const touched = fsFingerprint(p.root);
  assert.notEqual(touched, initial, "mtime");

  fs.appendFileSync(file, "more", "utf8");
  fs.utimesSync(file, later, later);
  const grown = fsFingerprint(p.root);
  assert.notEqual(grown, touched, "size");

  fs.rmSync(file);
  assert.notEqual(fsFingerprint(p.root), grown, "削除");
});

test("残課題2: fsFingerprint はシンボリックリンクを辿らない", (t) => {
  const p = createProject(t, { git: false });
  const outside = path.join(p.base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "a.txt"), "a", "utf8");
  try {
    // Windows でも権限なしで作れるよう junction にする（POSIX では通常のシンボリックリンクになる）
    fs.symlinkSync(outside, path.join(p.root, "link"), "junction");
  } catch {
    return t.skip("この環境ではリンクを作れない");
  }

  const before = fsFingerprint(p.root);
  fs.writeFileSync(path.join(outside, "b.txt"), "b", "utf8");
  fs.appendFileSync(path.join(outside, "a.txt"), "more", "utf8");
  assert.equal(fsFingerprint(p.root), before, "リンク先の中身は指紋に含めない");
});

test("残課題2: fsFingerprint は上限（エントリ数・走査時間）を超えたら null", (t) => {
  const p = createProject(t, { git: false });
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(p.root, `f${i}.txt`), "x", "utf8");

  assert.match(fsFingerprint(p.root, { maxEntries: 100 }), /^fs:/);
  assert.equal(fsFingerprint(p.root, { maxEntries: 3 }), null);
  assert.equal(fsFingerprint(p.root, { maxMs: -1 }), null);
  assert.equal(fsFingerprint(path.join(p.root, "no-such-dir")), null, "ルートが読めない");
});

test("レビュー1: fingerprint は HEAD を含む（編集してコミットすると変わる）", (t) => {
  const p = createProject(t);
  useCeiling(t, p.base);

  const before = fingerprint(p.root);
  p.change("edit");
  p.git(["commit", "-q", "-am", "edit"]);
  assert.notEqual(fingerprint(p.root), before);
});

test("レビュー3: fingerprint は .orchestra/ 配下の変更では変わらない", (t) => {
  const p = createProject(t);
  useCeiling(t, p.base);

  const before = fingerprint(p.root);
  p.writeConfig({ commands: ["echo changed"] });
  fs.writeFileSync(path.join(p.root, ".orchestra", "notes.txt"), "memo", "utf8");
  assert.equal(fingerprint(p.root), before);
});

test("レビュー4: maxRounds は 1 以上 20 以下の整数だけを受け付ける", (t) => {
  assert.equal(normalizeMaxRounds(1), 1);
  assert.equal(normalizeMaxRounds(20), 20);
  for (const bad of [0, -1, 21, 1.5, "3", null, undefined, Number.NaN]) {
    assert.equal(normalizeMaxRounds(bad), DEFAULT_MAX_ROUNDS);
  }
  assert.equal(normalizeMaxRounds(0, 7), 7);

  const p = createProject(t);
  for (const bad of [0, -3, 21]) {
    p.writeConfig({ maxRounds: bad, commands: [p.verifyCommand] });
    p.orch(["start"]);
    assert.equal(p.readState().maxRounds, DEFAULT_MAX_ROUNDS, `config maxRounds:${bad}`);
  }

  p.writeConfig({ maxRounds: 7, commands: [p.verifyCommand] });
  for (const bad of ["0", "-1", "21", "abc"]) {
    p.orch(["start", "--max-rounds", bad]);
    assert.equal(p.readState().maxRounds, 7, `--max-rounds ${bad} は config の値に落ちる`);
  }
  p.orch(["start", "--max-rounds", "20"]);
  assert.equal(p.readState().maxRounds, 20);
});

test("レビュー7: stop は state が無ければ「有効なゲートはありません」と表示する", (t) => {
  const p = createProject(t);
  const r = p.orch(["stop"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /orchestra: 有効なゲートはありません/);
  assert.doesNotMatch(r.stdout, /解除しました/);
});

test("レビュー7: stop は CLAUDE_PROJECT_DIR に state が無くても cwd の state を見つけて解除する", (t) => {
  const p = createProject(t);
  p.orch(["start"]);

  const r = p.orch(["stop"], { env: { CLAUDE_PROJECT_DIR: p.tools } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /orchestra: 検証ゲートを解除しました/);
  assert.equal(p.readState(), null);
});

test("レビュー7: stop は state を消せなければエラーを出して exit 1 にする", (t) => {
  const p = createProject(t);
  // 空でないディレクトリは unlink できない（どの OS でも ENOENT 以外で失敗する）
  const asDir = path.join(p.root, ".orchestra", "state.json");
  fs.mkdirSync(asDir);
  fs.writeFileSync(path.join(asDir, "keep"), "x", "utf8");

  const r = p.orch(["stop"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /orchestra: 検証ゲートを解除できませんでした/);
  assert.doesNotMatch(r.stdout, /解除しました/);
});

test("レビュー8: writeState は一時ファイルを残さず、内容を置き換える", (t) => {
  const p = createProject(t);
  writeState(p.root, { active: true, round: 1 });
  writeState(p.root, { active: false, round: 2 });
  assert.deepEqual(p.readState(), { active: false, round: 2 });
  assert.deepEqual(fs.readdirSync(path.join(p.root, ".orchestra")).sort(), ["config.json", "state.json"]);
});

test("レビュー10: config.json が JSON として読めなければ start で警告する", (t) => {
  const p = createProject(t);
  fs.writeFileSync(path.join(p.root, ".orchestra", "config.json"), "{ commands: [", "utf8");
  fs.writeFileSync(path.join(p.root, "package.json"), JSON.stringify({ scripts: { test: "x" } }), "utf8");

  const r = p.orch(["start"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /orchestra: 警告: \.orchestra\/config\.json を JSON として読めません/);
  assert.match(r.stdout, /- npm run test/, "検証コマンドは package.json からの推定に落ちる");
});

test("レビュー10: config.json が無い、または正しく読める場合は警告しない", (t) => {
  const p = createProject(t);
  assert.doesNotMatch(p.orch(["start"]).stdout, /読めません/);
  fs.rmSync(path.join(p.root, ".orchestra", "config.json"));
  assert.doesNotMatch(p.orch(["start"]).stdout, /読めません/);
});
