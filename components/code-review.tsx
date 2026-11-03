import { diffCode } from "@/lib/code-diff";

export default function CodeReview({ filePath, original, startLine, findingStart, findingEnd, before, after, suggestionStartLine }: {
  filePath: string; original: string; startLine: number; findingStart: number | null; findingEnd: number | null;
  before?: string; after?: string; suggestionStartLine?: number;
}) {
  const changes = before !== undefined && after !== undefined ? diffCode(before, after, suggestionStartLine ?? startLine) : null;
  return <div className="code-comparison">
    <section aria-label="기존 코드와 주변 문맥"><div className="code-heading"><strong>기존 코드 · 주변 문맥 포함</strong><span>{filePath}</span></div>
      <pre className="review-code"><code>{original.split(/\r?\n/).map((text, index) => {
        const line = startLine + index;
        return <span className={`review-line${findingStart !== null && line >= findingStart && line <= (findingEnd ?? findingStart) ? " finding-line" : ""}`} key={index}><span className="line-number" aria-hidden="true">{line}</span><span className="line-sign" aria-hidden="true"> </span><span>{text || " "}</span>{"\n"}</span>;
      })}</code></pre>
    </section>
    {changes && <section aria-label="AI 수정안 변경 비교"><div className="code-heading"><strong>AI 수정안 · 변경 비교</strong><span>− 삭제한 줄 · + 추가한 줄 · 나머지 줄은 유지</span></div>
      <pre className="review-code"><code>{changes.map((line, index) => <span className={`review-line diff-${line.kind}`} key={index}><span className="line-number" aria-hidden="true">{line.oldLine ?? ""}</span><span className="line-number" aria-hidden="true">{line.newLine ?? ""}</span><span className="line-sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><span>{line.text || " "}</span>{"\n"}</span>)}</code></pre>
      {before === after && <p className="code-unchanged">코드 변경 없이 설명만 제안되었습니다.</p>}
    </section>}
  </div>;
}
