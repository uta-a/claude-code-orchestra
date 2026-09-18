#!/usr/bin/env node
/**
 * PreToolUse フック: 読み取り専用のサブエージェントに、Bash で書き込み系のコマンドを実行させない。
 *
 * 設計上の要点
 * 1. サブエージェントの frontmatter の tools には `Bash(git diff:*)` のような権限ルールを書けない。
 *    そこで tools には素の Bash を入れ、このフックでコマンドを絞る。
 * 2. フック入力の agent_type は、サブエージェントからの呼び出しのときだけ入る。
 *    メイン会話と、対象外のエージェントには何もしない（何も出さず exit 0）。
 * 3. 許可するときも何も出さない。permissionDecision: "allow" を出すと通常の権限フローを
 *    飛ばしてしまうので、このフックは「拒否」しかしない。
 * 4. 許可リスト方式。読み取りだと分かっているコマンドだけを通し、それ以外はすべて拒否する。
 *    シェルの解釈とこちらの解釈がずれると抜け道になるので、ずれうる書き方
 *    （メタ文字、変数展開、グロブ展開、ブレース展開、バックスラッシュ）は中身を見ずに拒否する。
 * 5. 対象エージェントだと判定できた後の例外は拒否にする（fail closed）。
 *    判定できる前の失敗（stdin が読めない、JSON が壊れている）は、呼び出し元が分からないので通す。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 対象エージェントの定義。判定に関わる値はここだけに置く。
 *
 * プラグイン由来のエージェントの agent_type は "orchestra:reviewer" のように名前空間付きで入る
 * （公式ドキュメントに明記は無いが、Claude Code 2.1.276 の実機で確認済み）。
 * 素の名前まで対象にすると、他のプラグインやユーザー定義の同名エージェントを巻き込むので、
 * 名前空間付きだけを対象にしている。
 */
const GUARDED = {
  namespace: "orchestra:",
  names: ["planner", "explorer", "reviewer", "critic"],
  acceptBareNames: false,
};

// ls と pwd の引数のパスは制限しない（同じエージェントが Read / Glob でプロジェクト外も読めるため）
const ALLOWED_COMMANDS = ["ls", "pwd"];
const GIT_SUBCOMMANDS = ["diff", "log", "status", "show", "blame", "ls-files", "rev-parse"];
// git のサブコマンドより前に置けるもの。-C だけは次のトークン（パス）を伴う
const GIT_GLOBAL_FLAGS = ["--no-pager"];
const GIT_CHDIR = "-C";
const CHDIR_RULE = "git -C はプロジェクト内の相対パスだけ指定できる";

/**
 * 拒否する長いオプション。
 * - --output: ファイルに書き込める
 * - --no-index: リポジトリと無関係に、任意の2つのパスを比較できる
 * - --ext-diff / --textconv / --show-signature: 外部コマンド（diff.external、textconv、gpg）を起動する
 * - --help: マニュアルをブラウザや man で開く
 *
 * 残るリスク: textconv は git diff / show / log -p で既定で有効。フックは拒否しかできず --no-textconv を
 * 強制できないので、リポジトリ側の設定（textconv、core.fsmonitor、log.showSignature、gpg.program など）に
 * よる外部コマンドの起動は止められない。エージェント自身は -c などで設定を差し込めないが、
 * プロジェクト内に悪意ある設定を持つリポジトリ（埋め込まれた bare リポジトリを含む）があれば、
 * -C の相対パスで指定できる。
 */
const FORBIDDEN_LONG_OPTIONS = ["--output", "--ext-diff", "--no-index", "--show-signature", "--textconv", "--help"];
// 禁止オプションの前方一致に当たるが、それ自体が別の無害なオプションであるもの（git は完全一致を優先する）
const SAFE_EXACT_OPTIONS = ["--text"];
// 書式の %G? / %GS / %GK などは、--show-signature と同じく gpg を起動する
const SIGNATURE_PLACEHOLDER = "%G";

// 引用符の中かどうかは区別しない。含まれていれば拒否する（安全側に倒す）。
// `$` は `$(` だけでなく、変数展開や $'...' でトークンを組み立てられるので丸ごと拒否する
const SHELL_META = /[;&|<>`$]/;
// タブ以外の制御文字（改行を含む）
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;
// グロブ文字。cwd に `--output=x` という名前のファイルがあると、`git diff --*` がシェルの展開後に
// --output になる。引用符の内外を区別せず拒否する（ファイル名のパターン検索は Glob ツールで足りる）
const GLOB_CHARS = /[*?[]/;
// リビジョン指定の @{1} / @{upstream} の形。ブレース展開にならないものだけを見逃す
const REVISION_BRACES = /@\{[^{},]*\}/g;

const DENY_GUIDE =
  "orchestra: 読み取り専用エージェントの Bash は git diff / log / status / show / blame / ls-files / rev-parse と ls / pwd だけ使える。" +
  "パイプやリダイレクト、cd は使えないので、件数は -n、ディレクトリは git -C <プロジェクト内の相対パス> で指定する。" +
  "ファイルの中身は Read / Grep、ファイル名のパターン検索は Glob を使う。";

export function isGuardedAgent(agentType) {
  if (typeof agentType !== "string") return false;
  const namespaced = agentType.startsWith(GUARDED.namespace);
  if (!namespaced && !GUARDED.acceptBareNames) return false;
  const name = namespaced ? agentType.slice(GUARDED.namespace.length) : agentType;
  return GUARDED.names.includes(name);
}

/**
 * シェルと同じ単位にトークンを分ける。解釈に自信が持てない書き方は null を返す（呼び出し側で拒否）。
 *
 * 引用符を外してから検査しないと、`--out""put=f` や `-C "a status b" push` のように
 * こちらの見え方とシェルの見え方をずらして検査をすり抜けられる。
 * - 区切りは空白とタブだけ（bash の IFS と同じ。改行は事前に拒否している）
 * - '...' と "..." は中身をそのままトークンに含める
 * - バックスラッシュは '...' の中でだけ文字として扱う。それ以外は拒否
 * - 閉じていない引用符は拒否
 */
export function tokenize(command) {
  const tokens = [];
  let current = "";
  let started = false; // '' のような空のトークンも1つと数える
  let quote = null;

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') return null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") return null;
    if (ch === " " || ch === "\t") {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * 禁止している長いオプションか。
 * git は長いオプションを一意な前方一致の省略形でも受け付ける（--ext は --ext-diff になる）。
 * 省略形も拒否する。曖昧で git がエラーにする形（--o など）も、区別せず拒否でよい。
 */
function isForbiddenOption(token) {
  if (token.includes(SIGNATURE_PLACEHOLDER)) return true;
  const name = token.split("=")[0];
  if (SAFE_EXACT_OPTIONS.includes(name)) return false;
  if (FORBIDDEN_LONG_OPTIONS.some((option) => token.startsWith(option))) return true;
  if (!name.startsWith("--") || name.length <= 2) return false;
  return FORBIDDEN_LONG_OPTIONS.some((option) => option.startsWith(name));
}

/**
 * -C に渡せるパスか。プロジェクト（Bash の cwd）の外にある、悪意ある設定を持つリポジトリで
 * git を実行させないために、相対パスで、外に出ないものだけを許可する。
 * 区切りは / と \ の両方を見る（Windows の git はどちらも受け付ける）。
 * シンボリックリンクやジャンクションの先までは見ていない。
 */
function isProjectRelativePath(value) {
  if (value === "") return false;
  if (/^[\\/]/.test(value)) return false; // 絶対パス、UNC（//server、\\server）
  if (/^[A-Za-z]:/.test(value)) return false; // ドライブ指定（C:/x、C:x）
  if (value.startsWith("~")) return false; // ホーム（~、~user）
  return !value.split(/[\\/]/).includes("..");
}

function checkGit(tokens) {
  let index = 1;
  let chdirSeen = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (GIT_GLOBAL_FLAGS.includes(token)) {
      index += 1;
    } else if (token === GIT_CHDIR) {
      if (index + 1 >= tokens.length) return `${token} にパスが無い`;
      // 複数の -C は連結されるので、1つずつは内側でも合わせて外に出られる
      if (chdirSeen) return `${CHDIR_RULE}（-C は1回だけ）`;
      if (!isProjectRelativePath(tokens[index + 1])) return `${CHDIR_RULE}（絶対パス、..、~ は使えない）`;
      chdirSeen = true;
      index += 2;
    } else {
      break;
    }
  }

  // -c / --git-dir / --exec-path などのグローバルオプションは、ここでサブコマンド扱いになって弾かれる
  const subcommand = tokens[index];
  if (!GIT_SUBCOMMANDS.includes(subcommand)) {
    return subcommand === undefined
      ? "git のサブコマンドが無い"
      : `git の ${subcommand} は許可されていない（サブコマンドの前に置けるのは --no-pager と -C <path> だけ）`;
  }
  return null;
}

/**
 * コマンドを検査する。許可できるなら null、できないなら拒否の理由（短い日本語）を返す。
 */
export function checkCommand(command) {
  if (typeof command !== "string") return "command が文字列ではない";
  if (command.trim() === "") return "command が空";
  if (CONTROL_CHARS.test(command)) return "改行や制御文字は使えない";
  if (SHELL_META.test(command)) return "シェルのメタ文字（; & | > < ` $）は使えない";
  if (GLOB_CHARS.test(command)) return "グロブ文字（* ? [）は使えない";
  if (/[{}]/.test(command.replace(REVISION_BRACES, ""))) {
    return "波括弧は @{1} や @{upstream} の形でしか使えない";
  }

  const tokens = tokenize(command);
  if (tokens === null) return "バックスラッシュ、または閉じていない引用符がある";
  if (tokens.length === 0) return "command が空";

  const forbidden = tokens.find(isForbiddenOption);
  if (forbidden !== undefined) return `${forbidden} は使えない`;

  const head = tokens[0];
  if (head === "git") return checkGit(tokens);
  if (ALLOWED_COMMANDS.includes(head)) return null;
  return `${head} は許可されていない`;
}

function deny(cause) {
  const reason = cause ? `${DENY_GUIDE}（拒否した理由: ${cause}）` : DENY_GUIDE;
  // 書き込んだ直後に process.exit() すると、パイプへの出力が途中で切れることがある。
  // 拒否が届かないと素通しと同じになるので、exit は呼ばずに自然終了させる
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

function main() {
  let guarded = false;
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (input === null || typeof input !== "object") return;
    if (input.tool_name !== "Bash") return;
    // agent_type が無いのはメイン会話。対象外のエージェントと同じく何もしない
    if (!isGuardedAgent(input.agent_type)) return;

    guarded = true;
    const cause = checkCommand(input.tool_input?.command);
    if (cause !== null) deny(cause);
  } catch {
    // 対象エージェントだと分かった後の例外は拒否（fail closed）。それより前は呼び出し元が分からないので通す
    if (guarded) deny("コマンドを検査できなかった");
  }
}

/**
 * 直接起動されたか。ここが誤って false になると main() が走らず、黙って素通しになる。
 * 実体パスの URL を import.meta.url と突き合わせる（Windows のドライブ文字の大小、相対パス、
 * 8.3 短縮名でも一致することを確認済み）。realpath に失敗したときのために、
 * 他のスクリプトと同じ末尾一致の判定も残し、どちらかが成り立てば起動とみなす。
 */
function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    if (pathToFileURL(fs.realpathSync(entry)).href === import.meta.url) return true;
  } catch {
    /* 末尾一致の判定に任せる */
  }
  return path.resolve(entry).endsWith(path.join("scripts", "readonly-guard.mjs"));
}

if (isInvokedDirectly()) {
  main();
}
