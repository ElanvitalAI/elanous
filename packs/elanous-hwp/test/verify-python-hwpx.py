"""Check generated document content via the independently maintained python-hwpx API."""
import json
import sys
from hwpx import HwpxDocument

document = HwpxDocument.open(sys.argv[1])
paragraphs = [paragraph for section in document.sections for paragraph in section.paragraphs]
tables = [table for paragraph in paragraphs for table in paragraph.tables]
assert any('훈련 보고서' in paragraph.text for paragraph in paragraphs)
cells = [[cell.paragraphs[0].text for row in table.rows for cell in row.cells] for table in tables]
assert cells == [['코드', '능력단위', '0101', '훈련 운영', '0202', '평가 관리'], ['항목', '결과', '성과', '완료']]
print(json.dumps({'consumer': 'python-hwpx', 'sections': len(document.sections), 'tables': len(tables), 'heading': '훈련 보고서', 'cells': cells}, ensure_ascii=False))
