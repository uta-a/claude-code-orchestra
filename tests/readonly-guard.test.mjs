import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkCommand, isGuardedAgent, tokenize } from "../scripts/readonly-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, "..", "scripts", "readonly-guard.mjs");

/** PreToolUse フックを起動する。raw は stdin にそのまま渡す文字列 */
function guardRaw(raw) {
  const result = spawnSync(process.execPath, [GUARD], { input: raw, encoding: "utf8" });
  let output = null;
  if (result.stdout.trim()) output = JSON.parse(result.stdout);
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output,
    denied: output?.hookSpecificOutput?.permissionDecision === "deny",
    reason: output?.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

function guard(input) {
  return guardRaw(JSON.stringify(input));
}

function bash(agentType, command) {
  const input = { tool_name: "Bash", tool_input: { command } };
  if (agentType !== undefined) {
    input.agent_id = "agent-1";
    input.agent_type = agentType;
  }
  return guard(input);
}

function assertPassThrough(r, label) {
  assert.equal(r.code, 0, label);
  assert.equal(r.stdout, "", `${label}: 何も出力してはいけない`);
}

function assertDenied(r, label) {
  assert.equal(r.code, 0, label);
  assert.equal(r.denied, true, `${label}: deny されること`);
}

const GUARDED_AGENTS = [
  "orchestra:planner",
  "orchestra:explorer",
  "orchestra:reviewer",
  "orchestra:critic",
];

// 素の名前は、他のプラグインやユーザー定義の同名エージェントなので対象にしない
const BARE_NAMES = ["planner", "explorer", "reviewer", "critic"];

const ALLOWED = [
  "git diff",
  "git log -n 5 --oneline",
  "git -C sub status --porcelain",
  "git --no-pager show HEAD",
  "ls -la",
  "pwd",
];

const DENIED = [
  "rm -rf x",
  "git push",
  "git commit -m x",
  "git diff > out.txt",
  "git diff --output=out.txt",
  "git log | head",
  "git status; rm x",
  "git status && rm x",
  "git log `whoami`",
  "git log $(whoami)",
  "git -c core.pager=evil log",
  "git diff --ext-diff",
  "cd sub",
  "FOO=1 git status",
  "git status\nrm x",
  "git status\r\nrm x",
  "",
  "   ",
];

test("メイン会話（agent_type なし）は何を実行しても素通し", () => {
  for (const command of [...ALLOWED, ...DENIED]) {
    assertPassThrough(bash(undefined, command), JSON.stringify(command));
  }
});

test("対象外のエージェントは素通し", () => {
  for (const agentType of ["orchestra:implementer", "orchestra:verifier", "general-purpose"]) {
    for (const command of ["rm -rf x", "git push", "git diff > out.txt"]) {
      assertPassThrough(bash(agentType, command), `${agentType}: ${command}`);
    }
  }
});

test("対象エージェントで読み取りコマンドは素通し", () => {
  for (const command of ALLOWED) {
    assertPassThrough(bash("orchestra:reviewer", command), command);
  }
});

test("対象エージェントで書き込み系・検査できないコマンドは deny", () => {
  for (const command of DENIED) {
    assertDenied(bash("orchestra:reviewer", command), JSON.stringify(command));
  }
});

test("対象エージェントの4種すべてが deny される", () => {
  for (const agentType of GUARDED_AGENTS) {
    assertDenied(bash(agentType, "rm -rf x"), agentType);
  }
});

test("素の名前の同名エージェントは対象外で素通し", () => {
  for (const agentType of BARE_NAMES) {
    assertPassThrough(bash(agentType, "rm -rf x"), agentType);
  }
});

test("command が文字列でない、または tool_input が無ければ deny", () => {
  for (const toolInput of [{ command: 123 }, { command: null }, { command: ["git", "diff"] }, {}, null]) {
    const r = guard({ tool_name: "Bash", tool_input: toolInput, agent_id: "a", agent_type: "orchestra:reviewer" });
    assertDenied(r, JSON.stringify(toolInput));
  }
  const missing = guard({ tool_name: "Bash", agent_id: "a", agent_type: "orchestra:reviewer" });
  assertDenied(missing, "tool_input なし");
});

test("tool_name が Bash 以外は素通し", () => {
  for (const toolName of ["Write", "Edit", "Read", "bash"]) {
    const r = guard({
      tool_name: toolName,
      tool_input: { command: "rm -rf x" },
      agent_id: "a",
      agent_type: "orchestra:reviewer",
    });
    assertPassThrough(r, toolName);
  }
});

test("壊れた JSON、空の stdin、オブジェクトでない JSON は素通し", () => {
  for (const raw of ["{not json", "", "null", "42", '"text"']) {
    assertPassThrough(guardRaw(raw), JSON.stringify(raw));
  }
});

test("agent_type が文字列でなければ素通し（呼び出し元を識別できない）", () => {
  for (const agentType of [null, 1, {}, ["reviewer"]]) {
    const r = guard({ tool_name: "Bash", tool_input: { command: "rm -rf x" }, agent_type: agentType });
    assertPassThrough(r, JSON.stringify(agentType));
  }
});

test("deny の出力は PreToolUse の hookSpecificOutput 形式で、理由は日本語の案内", () => {
  const r = bash("orchestra:reviewer", "git push");
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.output), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(r.output.hookSpecificOutput).sort(), [
    "hookEventName",
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(r.output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(r.output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(r.reason, /^orchestra: /);
  assert.match(r.reason, /git diff/);
  assert.match(r.reason, /Read \/ Grep/);
});

test("起動パスの書き方が違っても直接起動と判定して deny する（黙って素通しにならない）", () => {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "git push" },
    agent_id: "a",
    agent_type: "orchestra:reviewer",
  });
  const variants = [
    { label: "スラッシュ区切り", args: [GUARD.replaceAll("\\", "/")] },
    { label: "相対パス", args: ["readonly-guard.mjs"], cwd: path.dirname(GUARD) },
    { label: "相対パス（..を含む）", args: ["../scripts/readonly-guard.mjs"], cwd: path.dirname(GUARD) },
  ];
  if (process.platform === "win32") {
    const resolved = path.resolve(GUARD);
    variants.push({ label: "ドライブ文字が小文字", args: [resolved[0].toLowerCase() + resolved.slice(1)] });
    variants.push({ label: "パス全体が小文字", args: [resolved.toLowerCase()] });
  }

  for (const { label, args, cwd } of variants) {
    const r = spawnSync(process.execPath, args, { input, cwd, encoding: "utf8" });
    assert.equal(r.status, 0, label);
    assert.match(r.stdout, /"permissionDecision":"deny"/, label);
  }
});

test("isGuardedAgent: 名前空間は先頭の1つだけ外し、完全一致で判定する", () => {
  assert.equal(isGuardedAgent("orchestra:reviewer"), true);
  assert.equal(isGuardedAgent("reviewer"), false);
  assert.equal(isGuardedAgent("orchestra:orchestra:reviewer"), false);
  assert.equal(isGuardedAgent("other:reviewer"), false);
  assert.equal(isGuardedAgent("orchestra:Reviewer"), false);
  assert.equal(isGuardedAgent("orch-reviewer"), false);
  assert.equal(isGuardedAgent("orchestra:"), false);
  assert.equal(isGuardedAgent(""), false);
  assert.equal(isGuardedAgent(undefined), false);
});

test("tokenize: 引用符を外してシェルと同じ単位に分ける", () => {
  assert.deepEqual(tokenize("git  log\t-n 5"), ["git", "log", "-n", "5"]);
  assert.deepEqual(tokenize(`git log --format='%h %s'`), ["git", "log", "--format=%h %s"]);
  assert.deepEqual(tokenize(`git -C "my dir" status`), ["git", "-C", "my dir", "status"]);
  assert.deepEqual(tokenize(`git -C 'C:\\work\\repo' status`), ["git", "-C", "C:\\work\\repo", "status"]);
  assert.deepEqual(tokenize(`git -C '' status`), ["git", "-C", "", "status"]);
  assert.deepEqual(tokenize(`--out""put=x`), ["--output=x"]);
  assert.equal(tokenize(`git log "unclosed`), null);
  assert.equal(tokenize(`git log --out\\put=x`), null);
  assert.equal(tokenize(`git log "a\\"b"`), null);
});

test("checkCommand: 引用符を使った正当な読み取りコマンドは許可する", () => {
  for (const command of [
    `git log --format='%h %s' -n 3`,
    `git log --grep="fix bug"`,
    `git -C "my dir" status`,
    `git --no-pager -C sub --no-pager diff HEAD~1 -- src/a.js`,
    "git diff HEAD@{1} HEAD",
    "git log @{upstream}..HEAD",
    "git diff --exit-code",
    "git log --oneline",
    "git ls-files -o --exclude-standard",
    "git rev-parse --show-toplevel",
    "git blame -L 1,5 README.md",
    "  git status  ",
    "ls",
    // グロブ文字の拒否に巻き込まれてはいけないリビジョン指定・書式
    "git show HEAD^",
    "git diff HEAD~2 HEAD",
    "git show HEAD@{1}",
    "git log --format=%h -n 3",
  ]) {
    assert.equal(checkCommand(command), null, command);
  }
});

test("checkCommand: グロブ文字（* ? [）は引用符の内外を問わず拒否する", () => {
  // cwd に `--output=x` という名前のファイルがあると、シェルの展開後に git へ --output が渡る
  for (const command of [
    "git diff --*",
    "ls --*",
    "ls *.md",
    "git log -- src/[ab].js",
    "git show HEAD:file?.txt",
    `git log -- '*.js'`,
    `git log --grep="a[bc]"`,
  ]) {
    assert.notEqual(checkCommand(command), null, command);
  }
});

test("グロブ文字を含むコマンドは対象エージェントで deny され、理由文が Glob を案内する", () => {
  for (const command of ["git diff --*", "ls --*"]) {
    const r = bash("orchestra:reviewer", command);
    assertDenied(r, command);
    assert.match(r.reason, /Glob/);
  }
  assertPassThrough(bash(undefined, "ls *.md"), "メイン会話");
});

test("checkCommand: git -C はプロジェクト内の相対パスを1回だけ指定できる", () => {
  for (const command of [
    "git -C sub status --porcelain",
    "git -C packages/app log -n 3",
    "git -C ./sub status",
    `git -C "my dir" status`,
    "git -C sub..x status",
    "git --no-pager -C sub --no-pager diff",
  ]) {
    assert.equal(checkCommand(command), null, command);
  }

  for (const command of [
    // 絶対パス（/ 始まり、ドライブ指定、UNC）
    "git -C /etc status",
    "git -C C:/other log",
    "git -C c:other log",
    `git -C 'C:\\other' log`,
    "git -C //server/share status",
    `git -C '\\\\server\\share' status`,
    `git -C '\\other' status`,
    // プロジェクトの外に出る
    "git -C ../other status",
    "git -C .. status",
    "git -C sub/../../x status",
    "git -C sub/.. status",
    `git -C 'sub\\..\\..\\x' status`,
    `git -C "../other" status`,
    // ホーム
    "git -C ~/repo status",
    "git -C ~ status",
    `git -C "~/repo" status`,
    // 連結して外に出られる
    "git -C a -C b status",
    "git -C a --no-pager -C ../.. status",
    // 空
    "git -C '' status",
  ]) {
    assert.notEqual(checkCommand(command), null, command);
  }
});

test("git -C の拒否は、プロジェクト内の相対パスだけ指定できると伝える", () => {
  for (const command of ["git -C /etc status", "git -C ../other status", "git -C a -C b status"]) {
    const r = bash("orchestra:reviewer", command);
    assertDenied(r, command);
    assert.match(r.reason, /git -C はプロジェクト内の相対パスだけ指定できる/, command);
  }
  assertPassThrough(bash("orchestra:reviewer", "git -C packages/app log -n 3"), "相対パス");
});

test("checkCommand: --no-index は省略形も拒否し、無害な --no-* は巻き込まない", () => {
  for (const command of [
    "git diff --no-index a b",
    "git diff --no-i a b",
    "git diff --no-in a b",
    "git diff --no-inde a b",
    `git diff --no-"index" a b`,
    "git -C sub diff --no-index a b",
  ]) {
    assert.notEqual(checkCommand(command), null, command);
  }

  for (const command of [
    "git --no-pager show HEAD",
    "git log --no-merges -n 5",
    "git diff --no-color",
    "git log --no-patch -n 1",
    "git diff --no-renames",
    "git show --no-textconv HEAD:a",
    "git diff --no-ext-diff",
    "git log --no-show-signature -n 1",
    "git status --no-ahead-behind",
  ]) {
    assert.equal(checkCommand(command), null, command);
  }
});

test("checkCommand: 外部コマンドの起動につながるオプションを拒否する", () => {
  for (const command of [
    // gpg を起動する
    "git log --show-signature",
    "git show --show-sig HEAD",
    "git log --format=%GS -n 1",
    `git log --pretty='format:%h %GK' -n 1`,
    // textconv の明示指定
    "git show --textconv HEAD:a",
    "git diff --textc",
    // 設定の差し込み（グローバルオプションは --no-pager と -C 以外すべて拒否済み）
    "git -c core.fsmonitor=evil status",
    "git -c diff.external=evil diff",
    "git -C sub -c core.fsmonitor=evil status",
    "git --config-env=core.pager=X log",
    // マニュアルをブラウザや man で開く
    "git log --help",
    "git status --hel",
  ]) {
    assert.notEqual(checkCommand(command), null, command);
  }

  // 禁止オプションの前方一致に当たるが、それ自体が別の無害なオプション
  for (const command of ["git diff --text", "git rev-parse --show-toplevel", "git diff -h"]) {
    assert.equal(checkCommand(command), null, command);
  }
});

test("checkCommand: ls と pwd の引数のパスは制限しない", () => {
  for (const command of ["ls ..", "ls -la /tmp", "ls ~", "pwd -P"]) {
    assert.equal(checkCommand(command), null, command);
  }
});

test("checkCommand: シェルの解釈とのずれを突くすり抜けを拒否する", () => {
  for (const command of [
    // 引用符・バックスラッシュでオプション名を分断する
    `git diff --out""put=out.txt`,
    `git diff "--output=out.txt"`,
    `git diff '--output' out.txt`,
    `git diff --out\\put=out.txt`,
    // 引用符で囲んだ空白で、サブコマンドの位置をずらす
    `git -C "a status b" push`,
    `git -C 'x' "push"`,
    // git は一意な前方一致の省略形を受け付ける
    "git diff --ext",
    "git diff --ext-d",
    "git diff --outpu=out.txt",
    // ブレース展開・変数展開・ANSI-C 引用でオプションを組み立てる
    "git diff --outpu{t,t}=out.txt",
    "git diff {--output=out.txt,}",
    "git diff --out{{x},put}=out.txt",
    "git diff $'\\x2d\\x2doutput=out.txt'",
    "git diff $OUT",
    "git diff ${OUT}",
    // グローバルオプション
    "git --git-dir=other/.git log",
    "git --exec-path=evil log",
    "git -p log",
    "git --paginate log",
    "git -C",
    "git -C sub",
    "git",
    "git --no-pager",
    // 許可していないサブコマンド・コマンド
    "git stash",
    "git checkout -- a.txt",
    "git config user.name x",
    "git branch -D main",
    "GIT status",
    `"rm" -rf x`,
    "(git status)",
    "echo hi",
    "cat a.txt",
    // その他のメタ文字・制御文字
    "git status & rm x",
    "git status || rm x",
    "git log < in.txt",
    "git log >> out.txt",
    "git status\vrm x",
    "git status\0",
  ]) {
    assert.notEqual(checkCommand(command), null, JSON.stringify(command));
  }
});
