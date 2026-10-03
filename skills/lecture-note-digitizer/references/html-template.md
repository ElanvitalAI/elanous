# HTML 템플릿 — 학습노트 PDF용 (v2, 2026-04-06)

그라데이션 커버 + 카드 TOC + 섹션 래퍼 스타일. eco_lecture/scm_lecture 공통 템플릿.

## 표준 HTML 구조

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>{과목코드} {과목명} {N}주차 학습 노트</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body,{delimiters:[
      {left:'$$',right:'$$',display:true},
      {left:'\\(',right:'\\)',display:false},
      {left:'\\[',right:'\\]',display:true}
    ]});"></script>
  <style>{CSS}</style>
</head>
<body>

<!-- COVER PAGE: 그라데이션 배경, 흰색 텍스트 -->
<div class="cover">
  <h1>{과목코드} {과목명} {N}주차 학습 노트</h1>
  <h2>{부제: 주차 핵심 주제}</h2>
  <div class="meta">
    <p><strong>과목명:</strong> {영문명}</p>
    <p><strong>프로그램:</strong> {프로그램}</p>
    <p><strong>교수:</strong> {교수명}</p>
    <p><strong>일시:</strong> {날짜}</p>
  </div>
  <div class="badge">핵심 키워드: {키워드}</div>
</div>

<!-- TOC: 카드 스타일, 자동 생성 -->
<div class="toc">
  <h2>목차</h2>
  {build_toc()으로 자동 생성된 <ol>}
</div>

<!-- CONTENT -->
<div class="section">
  {html_body}
</div>
</body>
</html>
```

## CSS

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Noto Sans KR', sans-serif;
  font-size: 16px; line-height: 1.8; color: #1a1a2e; background: #f8f9fc;
}

.section {
  background: #fff; border-radius: 12px; padding: 40px;
  max-width: 900px; margin: 24px auto;
  box-shadow: 0 4px 24px rgba(0,0,0,0.06);
}

/* Cover — 그라데이션 */
.cover {
  min-height: 100vh; display: flex; flex-direction: column;
  justify-content: center; align-items: center; text-align: center;
  background: linear-gradient(135deg, #1e3a5f 0%, #3b82f6 50%, #8b5cf6 100%);
  color: #fff; padding: 60px 40px; page-break-after: always;
}
.cover h1 { font-size: 2.6em; font-weight: 800; margin-bottom: 16px; border-bottom: none; letter-spacing: -0.02em; }
/* 주의: text-shadow 사용 금지 — Playwright PDF에서 한국어 대형 텍스트에 회색 박스 아티팩트 발생 */
/* 제목이 길면 <br><span style="font-size:0.75em;font-weight:400;">부제</span>로 2줄 분리 */
.cover h2 { font-size: 1.4em; font-weight: 400; opacity: 0.9; margin-bottom: 40px; }
.cover .meta { font-size: 1em; opacity: 0.8; line-height: 2; }
.cover .meta strong { opacity: 1; }
.cover .badge {
  display: inline-block; background: rgba(255,255,255,0.2);
  border: 1px solid rgba(255,255,255,0.3); border-radius: 20px;
  padding: 6px 20px; margin-top: 30px; font-size: 0.9em;
}

/* TOC — 카드 */
.toc {
  background: #fff; border-radius: 12px; padding: 40px;
  margin: 40px auto; max-width: 900px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06); page-break-after: always;
}
.toc h2 { font-size: 1.6em; color: #1e3a5f; margin-bottom: 24px; border-bottom: 3px solid #3b82f6; }
.toc ol { list-style: none; counter-reset: toc-counter; }
.toc > ol > li { counter-increment: toc-counter; margin-bottom: 8px; }
.toc > ol > li > a {
  display: block; padding: 10px 16px; color: #1e3a5f;
  text-decoration: none; font-weight: 600; border-radius: 8px;
}
.toc > ol > li > a::before { content: counter(toc-counter) ". "; color: #3b82f6; font-weight: 700; }
.toc ol ol { margin-left: 24px; margin-top: 4px; }
.toc ol ol li a { display: block; padding: 5px 12px; color: #475569; font-size: 0.95em; border-radius: 6px; }

/* Typography */
h1 { font-size: 2em; color: #1e3a5f; margin: 32px 0 20px; border-bottom: 3px solid #3b82f6; page-break-before: always; }
.section h1:first-child { page-break-before: avoid; }
h2 { font-size: 1.5em; color: #1e3a5f; margin: 28px 0 16px; border-bottom: 2px solid #e2e8f0; }
h3 { font-size: 1.2em; color: #334155; margin: 20px 0 12px; }

/* Tables — 그라데이션 헤더 */
table { width: 100%; border-collapse: collapse; margin: 20px 0; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
thead th { background: linear-gradient(135deg, #1e3a5f, #3b82f6); color: #fff; padding: 12px 16px; }
tbody td { padding: 10px 16px; border-bottom: 1px solid #e2e8f0; }
tbody tr:nth-child(even) { background: #f8fafc; }

/* Blockquotes — 3종 */
blockquote { background: linear-gradient(135deg, #eef2ff, #f0f4ff); border-left: 4px solid #3b82f6; padding: 16px 20px; margin: 16px 0; border-radius: 0 8px 8px 0; }
.formula-box { background: linear-gradient(135deg, #fefce8, #fef9c3); border-left: 4px solid #f59e0b; border-radius: 10px; }
.case-box { background: linear-gradient(135deg, #ecfdf5, #d1fae5); border-left: 4px solid #10b981; }

/* Diagrams */
.diagram-container { text-align: center; margin: 24px 0; padding: 16px; background: #fafbff; border-radius: 10px; border: 1px solid #e2e8f0; page-break-inside: avoid; }
.diagram-container img { max-width: 100%; max-height: 500px; height: auto; object-fit: contain; border-radius: 8px; }
.diagram-caption { margin-top: 10px; font-size: 0.88em; color: #64748b; font-style: italic; }

/* HR */
hr { border: none; height: 2px; background: linear-gradient(90deg, #3b82f6, #8b5cf6); margin: 32px 0; }

/* Print */
@media print {
  body { background: #fff; font-size: 14px; }
  .section { box-shadow: none; margin: 0; padding: 24px 0; }
  .cover { min-height: auto; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cover h1 { page-break-before: avoid; border-bottom: none; }
  thead th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .diagram-container img { max-height: 400px; }
  table, .diagram-container, blockquote, .formula-box { page-break-inside: avoid; }
  h2, h3 { page-break-after: avoid; }
}
```

## Python 필수 함수 (convert_to_pdf.py에 포함)

### LaTeX 보호/복원 (markdown 라이브러리가 `\(` backslash 제거 방지)
```python
text = text.replace(r"\(", "LATEX_INLINE_OPEN")  # 변환 전
html = html.replace("LATEX_INLINE_OPEN", r"\(")  # 변환 후
```

### heading ID + TOC 자동 생성
```python
def add_ids_to_headings(html):
    counter = [0]
    def replacer(m):
        counter[0] += 1
        return f'<{m.group(1)} id="sec-{counter[0]}">{m.group(2)}</{m.group(1)}>'
    return re.sub(r'<(h[12])>(.*?)</\1>', replacer, html)

def build_toc(html_body):
    headings = re.findall(r'<(h[12])[^>]*id="([^"]*)"[^>]*>(.*?)</\1>', html_body)
    # h1 → 1레벨, h2 → 2레벨 nested <ol> 생성
```

### Blockquote 분류
- `Big Picture|핵심|가치 함수|확장된` → `.formula-box`
- `사례|Case|Figure` → `.case-box`
- 그 외 → `.insight-box` (기본 blockquote 스타일)
