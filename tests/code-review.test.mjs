import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadServerModule } from "./helpers/server-module.mjs";

const { sourceContext, diffCode } = loadServerModule("lib/code-diff.ts");
const { shouldPregenerate } = loadServerModule("lib/remediation-policy.ts");

test("captures five lines above and below, clamped at file boundaries", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const context = sourceContext(lines, 10, 11);
  assert.equal(context.contextStartLine, 5);
  assert.equal(context.contextEndLine, 16);
  assert.equal(context.codeContext.split("\n").length, 12);
  assert.equal(sourceContext(lines, 1, 2).contextStartLine, 1);
  assert.equal(sourceContext(lines, 29, 30).contextEndLine, 30);
});

test("diff preserves exact old/new code, line numbers and neutral context for replacements, insertions and removals", () => {
  for (const [before, after] of [["top\nunsafe()\nbottom", "top\nsafe()\nbottom"], ["a\nb", "a\nnew\nb"], ["a\nremoved\nb", "a\nb"], ["same", "same"], ["a\n", "b\n"]]) {
    const rows = diffCode(before, after, 20);
    assert.equal(rows.filter(row => row.kind !== "added").map(row => row.text).join("\n"), before);
    assert.equal(rows.filter(row => row.kind !== "removed").map(row => row.text).join("\n"), after);
    assert.deepEqual(rows.filter(row => row.oldLine !== null).map(row => row.oldLine), before.split("\n").map((_, i) => i + 20));
    assert.deepEqual(rows.filter(row => row.newLine !== null).map(row => row.newLine), after.split("\n").map((_, i) => i + 20));
  }
  const large = diffCode(Array(600).fill("old").join("\n"), Array(600).fill("new").join("\n"));
  assert.equal(large.filter(row => row.kind === "removed").length, 600);
  assert.equal(large.filter(row => row.kind === "added").length, 600);
});

test("7.0 threshold includes all high findings, uses severity only when no numeric score and excludes dismissed findings", () => {
  assert.equal(shouldPregenerate("medium", 6.9, "open"), false);
  assert.equal(shouldPregenerate("medium", 7, "open"), true);
  assert.equal(shouldPregenerate("high", 5.3, "open"), false);
  assert.equal(shouldPregenerate("high", null, "open"), true);
  assert.equal(shouldPregenerate("critical", 9.1, "resolved"), false);
  assert.equal(shouldPregenerate("critical", 9.1, "false_positive"), false);
});

test("review stacks original above unified changes, escapes source and includes plus/minus indicators", () => {
  const Review = loadServerModule("components/code-review.tsx").default;
  const html = renderToStaticMarkup(createElement(Review, { filePath: "src/test.ts", original: "top\n<script>unsafe()</script>\nbottom", startLine: 5, findingStart: 6, findingEnd: 6, before: "top\n<script>unsafe()</script>\nbottom", after: "top\nsafe()\nbottom", suggestionStartLine: 5 }));
  assert.ok(html.indexOf("기존 코드와 주변 문맥") < html.indexOf("AI 수정안 변경 비교"));
  assert.match(html, /finding-line/);
  assert.match(html, /diff-removed/);
  assert.match(html, /diff-added/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes("<script>"));
});

test("detail merges impact and guidance in plain language and displays code while automatic generation is pending", () => {
  const Detail = loadServerModule("components/vulnerability-detail.tsx").default;
  const html = renderToStaticMarkup(createElement(Detail, { vulnerability: { id: "sample", repositoryId: "repo", severity: "medium", title: "외부 리다이렉트(CWE-601)", impact: "정상 사이트의 링크를 이용해 사용자를 피싱 사이트로 유도할 가능성이 있습니다.", description: "외부 입력값을 검증하여 허용된 내부 경로로 제한하고 외부 URL을 거부하세요.", filePath: "sample.py", startLine: 2, endLine: 2, code: "return target", codeContext: "def redirect(target):\n    return target", contextStartLine: 1, status: "open" }, repositoryName: "repo", aiSelection: { provider: "openrouter", model: "openrouter/free" } }));
  assert.match(html, /문제와 해결 방법/);
  assert.ok(html.indexOf("피싱 사이트") < html.indexOf("외부 URL을 거부"));
  assert.ok(!html.includes(">결함 설명<") && !html.includes(">야기될 문제<"));
  assert.match(html, /수정안 준비를 기다리고/);
  assert.match(html, /return target/);
  assert.ok(!html.includes("AI 수정안 생성</button>"));
});

test("unmapped Semgrep descriptions are rendered verbatim without custom impact or rewritten guidance", () => {
  const Detail = loadServerModule("components/vulnerability-detail.tsx").default;
  const raw = "Original Semgrep message with its original recommendation.";
  const html = renderToStaticMarkup(createElement(Detail, { vulnerability: { id: "sample", repositoryId: "repo", severity: "info", title: "Semgrep fixture", descriptionSource: "semgrep", description: raw, impact: "custom text must not appear", filePath: "sample.py", startLine: null, endLine: null, code: null, status: "open" }, repositoryName: "repo", aiSelection: { provider: "openrouter", model: "openrouter/free" } }));
  assert.match(html, /Semgrep 탐지 원문/);
  assert.ok(html.includes(raw));
  assert.ok(!html.includes("custom text must not appear"));
});
