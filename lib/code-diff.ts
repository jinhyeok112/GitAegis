export interface DiffLine { kind: "context" | "removed" | "added"; text: string; oldLine: number | null; newLine: number | null }

export function sourceContext(lines: string[], start: number, end: number) {
  const first = Math.max(1, start - 5);
  const last = Math.min(lines.length, end + 5, first + 119);
  const selected: string[] = [];
  let size = 0;
  for (const line of lines.slice(first - 1, last)) {
    if (size + line.length + 1 > 12000) break;
    selected.push(line); size += line.length + 1;
  }
  return { codeContext: selected.join("\n"), contextStartLine: first, contextEndLine: first + selected.length - 1 };
}

// Line-based LCS keeps unchanged context neutral. Bound the matrix for unusual
// model output; the fallback still preserves exact removed/added source text.
export function diffCode(before: string, after: string, startLine = 1): DiffLine[] {
  const old = before.replace(/\r\n/g, "\n").split("\n"), next = after.replace(/\r\n/g, "\n").split("\n");
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  const push = (kind: DiffLine["kind"]) => result.push({ kind, text: kind === "added" ? next[j] : old[i], oldLine: kind === "added" ? null : startLine + i++, newLine: kind === "removed" ? null : startLine + j++ });
  if (old.length * next.length > 250000) {
    while (i < old.length && j < next.length && old[i] === next[j]) push("context");
    let suffix = 0;
    while (old.length - suffix > i && next.length - suffix > j && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
    while (i < old.length - suffix) push("removed");
    while (j < next.length - suffix) push("added");
    while (i < old.length) push("context");
    return result;
  }
  const lengths = Array.from({ length: old.length + 1 }, () => new Uint16Array(next.length + 1));
  for (let a = old.length - 1; a >= 0; a--) for (let b = next.length - 1; b >= 0; b--) lengths[a][b] = old[a] === next[b] ? lengths[a + 1][b + 1] + 1 : Math.max(lengths[a + 1][b], lengths[a][b + 1]);
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) push("context");
    else if (i < old.length && (j === next.length || lengths[i + 1][j] >= lengths[i][j + 1])) push("removed");
    else push("added");
  }
  return result;
}
