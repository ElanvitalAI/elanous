#!/usr/bin/env python3
"""HWP 5 text extraction and HWPX document creation, reading, and form filling."""
import argparse
import copy
import json
import posixpath
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph'
HH = 'http://www.hancom.co.kr/hwpml/2011/head'
OPF = 'http://www.idpf.org/2007/opf/'
for prefix, uri in [('hp', HP), ('hh', HH), ('opf', OPF)]:
    ET.register_namespace(prefix, uri)


def tag(ns, name):
    return '{%s}%s' % (ns, name)


def failure(message):
    raise ValueError(message)


def safe_target(source, output):
    if source is not None and Path(source).resolve() == Path(output).resolve():
        failure('입력 문서를 덮어쓸 수 없습니다. 다른 출력 경로를 지정하세요.')
    if Path(output).exists():
        failure('출력 파일이 이미 있습니다. 새 출력 경로를 지정하세요.')


def template_for(name):
    path = Path(__file__).resolve().parent.parent / 'templates' / (name + '.yaml')
    if name not in ('report', 'official-letter') or not path.is_file():
        failure('템플릿은 report 또는 official-letter여야 합니다.')
    # The bundled templates are JSON-compatible YAML: parse with the stdlib.
    return json.loads(path.read_text(encoding='utf-8'))


def inline(parent, text):
    """Encode markdown emphasis into run/charPrIDRef without losing plain text."""
    for segment in re.split(r'(\*\*[^*\n]+\*\*)', text):
        if not segment:
            continue
        bold = segment.startswith('**') and segment.endswith('**')
        run = ET.SubElement(parent, tag(HP, 'run'), {'charPrIDRef': '1' if bold else '0'})
        ET.SubElement(run, tag(HP, 't')).text = segment[2:-2] if bold else segment


def paragraph(parent, text, style=0):
    p = ET.SubElement(parent, tag(HP, 'p'), {'id': '0', 'paraPrIDRef': str(style), 'styleIDRef': '0', 'pageBreak': '0', 'columnBreak': '0', 'merged': '0'})
    inline(p, text)
    if 1 <= style <= 6:
        for run in p.findall(tag(HP, 'run')):
            run.set('charPrIDRef', str(style + 1))
    return p


def table_cells(line):
    """Split a GFM row at unescaped pipes and decode escaped pipes/backslashes."""
    cells = []
    cell = []
    text = line.strip()[1:-1]
    index = 0
    while index < len(text):
        char = text[index]
        if char == '\\' and index + 1 < len(text) and text[index + 1] in ('|', '\\'):
            cell.append(text[index + 1])
            index += 2
            continue
        if char == '|':
            cells.append(''.join(cell).strip())
            cell = []
        else:
            cell.append(char)
        index += 1
    cells.append(''.join(cell).strip())
    return cells


def parse_markdown(markdown):
    blocks = []
    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith('|') and line.endswith('|'):
            rows = []
            saw_delimiter = False
            while i < len(lines) and lines[i].strip().startswith('|') and lines[i].strip().endswith('|'):
                cells = table_cells(lines[i])
                # Only the line right after the header row is the delimiter (review R3): a data row whose cells
                # happen to be «---» is content, not a separator.
                is_delimiter = len(rows) == 1 and not saw_delimiter and all(re.fullmatch(r':?-{3,}:?', cell) for cell in cells)
                if is_delimiter:
                    saw_delimiter = True
                else:
                    rows.append(cells)
                i += 1
            if rows:
                width = len(rows[0])
                if any(len(row) != width for row in rows):
                    failure('표의 열 개수가 일치하지 않습니다.')
                blocks.append(('table', rows))
            continue
        heading = re.match(r'^(#{1,6})\s+(.+)$', line)
        listing = re.match(r'^([-*+] |\d+\. )(.+)$', line)
        if heading:
            blocks.append(('heading', len(heading[1]), heading[2]))
        elif listing:
            blocks.append(('list', listing[2]))
        else:
            blocks.append(('paragraph', line))
        i += 1
    return blocks


def build_hwpx(markdown, config):
    font = config['font']
    size = int(config['size_pt']) * 100
    margin = config['margin_mm']
    header = ET.Element(tag(HH, 'head'), {'version': '1.4', 'secCnt': '1'})
    ET.SubElement(header, tag(HH, 'beginNum'), {'page': '1', 'footnote': '1', 'endnote': '1', 'pic': '1', 'tbl': '1', 'equation': '1'})
    refs = ET.SubElement(header, tag(HH, 'refList'))
    face_names = ET.SubElement(refs, tag(HH, 'fontfaces'), {'itemCnt': '1'})
    for lang in ('HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'):
        face = ET.SubElement(face_names, tag(HH, 'fontface'), {'lang': lang, 'fontCnt': '1'})
        ET.SubElement(face, tag(HH, 'font'), {'id': '0', 'face': font, 'type': 'TTF', 'isEmbedded': '0'})
    char_list = ET.SubElement(refs, tag(HH, 'charProperties'), {'itemCnt': '8'})
    heading_scale = (1.8, 1.6, 1.4, 1.3, 1.2, 1.1)
    for char_id in range(8):
        height = round(size * heading_scale[char_id - 2]) if char_id >= 2 else size
        ch = ET.SubElement(char_list, tag(HH, 'charPr'), {'id': str(char_id), 'height': str(height), 'textColor': '#000000', 'shadeColor': 'none', 'useFontSpace': '0', 'useKerning': '0', 'bold': '1' if char_id else '0', 'italic': '0'})
        ET.SubElement(ch, tag(HH, 'fontRef'), {lang: '0' for lang in ('hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user')})
        ET.SubElement(ch, tag(HH, 'ratio'), {lang: '100' for lang in ('hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user')})
        ET.SubElement(ch, tag(HH, 'spacing'), {lang: '0' for lang in ('hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user')})
        ET.SubElement(ch, tag(HH, 'relSz'), {lang: '100' for lang in ('hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user')})
        ET.SubElement(ch, tag(HH, 'offset'), {lang: '0' for lang in ('hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user')})
    para_props = ET.SubElement(refs, tag(HH, 'paraProperties'), {'itemCnt': '8'})
    for n in range(8):
        p = ET.SubElement(para_props, tag(HH, 'paraPr'), {'id': str(n), 'tabPrIDRef': '0', 'condense': '0', 'fontLineHeight': '0', 'snapToGrid': '1'})
        ET.SubElement(p, tag(HH, 'align'), {'horizontal': 'LEFT', 'vertical': 'BASELINE'})
    borders = ET.SubElement(refs, tag(HH, 'borderFills'), {'itemCnt': '1'})
    border = ET.SubElement(borders, tag(HH, 'borderFill'), {'id': '1', 'threeD': '0', 'shadow': '0', 'centerLine': 'NONE', 'breakCellSeparateLine': '0'})
    for side in ('left', 'right', 'top', 'bottom'):
        ET.SubElement(border, tag(HH, side + 'Border'), {'type': 'SOLID' if config['table']['border'] == 'solid' else 'NONE', 'width': '0.12 mm', 'color': '#000000'})
    styles = ET.SubElement(refs, tag(HH, 'styles'), {'itemCnt': '1'})
    ET.SubElement(styles, tag(HH, 'style'), {'id': '0', 'type': 'PARA', 'name': 'Normal', 'engName': 'Normal', 'paraPrIDRef': '0', 'charPrIDRef': '0', 'nextStyleIDRef': '0', 'langID': '1042'})
    section = ET.Element(tag(HP, 'sec'))
    secpr = paragraph(section, '')
    run = ET.SubElement(secpr, tag(HP, 'run'), {'charPrIDRef': '0'})
    sp = ET.SubElement(run, tag(HP, 'secPr'), {'id': '0', 'textDirection': 'HORIZONTAL', 'spaceColumns': '0', 'tabStop': '8000', 'outlineShapeIDRef': '0', 'memoShapeIDRef': '0', 'textVerticalWidthHead': '0'})
    ET.SubElement(sp, tag(HP, 'pagePr'), {'landscape': 'WIDELY', 'width': '59528', 'height': '84188', 'gutterType': 'LEFT_ONLY'})
    ET.SubElement(sp, tag(HP, 'pageMargin'), {k: str(int(margin.get(k, 20)) * 283) for k in ('left', 'right', 'top', 'bottom')})
    for block in parse_markdown(markdown):
        if block[0] == 'heading':
            paragraph(section, block[2], block[1])
        elif block[0] == 'list':
            paragraph(section, '• ' + block[1], 7)
        elif block[0] == 'paragraph':
            paragraph(section, block[1])
        else:
            rows = block[1]
            p = paragraph(section, '')
            run = ET.SubElement(p, tag(HP, 'run'), {'charPrIDRef': '0'})
            table = ET.SubElement(run, tag(HP, 'tbl'), {'id': '1', 'zOrder': '0', 'numberingType': 'TABLE', 'textWrap': 'TOP_AND_BOTTOM', 'textFlow': 'BOTH_SIDES', 'lock': '0', 'rowCnt': str(len(rows)), 'colCnt': str(len(rows[0])), 'cellSpacing': '0', 'borderFillIDRef': '0'})
            for r, row in enumerate(rows):
                tr = ET.SubElement(table, tag(HP, 'tr'))
                for c, text in enumerate(row):
                    tc = ET.SubElement(tr, tag(HP, 'tc'), {'name': '', 'header': '1' if r == 0 else '0', 'hasMargin': '0', 'protect': '0', 'editable': '0', 'borderFillIDRef': '1'})
                    ET.SubElement(tc, tag(HP, 'cellAddr'), {'colAddr': str(c), 'rowAddr': str(r)})
                    ET.SubElement(tc, tag(HP, 'cellSpan'), {'colSpan': '1', 'rowSpan': '1'})
                    ET.SubElement(tc, tag(HP, 'cellSz'), {'width': '10000', 'height': '2400'})
                    sub = ET.SubElement(tc, tag(HP, 'subList'), {'id': '0', 'textDirection': 'HORIZONTAL', 'lineWrap': 'BREAK', 'vertAlign': 'CENTER'})
                    cell_p = paragraph(sub, text)
                    if r == 0 and config['table']['header'] == 'bold':
                        for cell_run in cell_p.findall(tag(HP, 'run')):
                            cell_run.set('charPrIDRef', '1')
    return header, section


def xml_bytes(root):
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def write_hwpx(path, header, section):
    content = ET.Element(tag(OPF, 'package'), {'version': '1.0', 'unique-identifier': 'uid'})
    metadata = ET.SubElement(content, tag(OPF, 'metadata'))
    ET.SubElement(metadata, tag(OPF, 'title')).text = 'Elanous document'
    manifest = ET.SubElement(content, tag(OPF, 'manifest'))
    ET.SubElement(manifest, tag(OPF, 'item'), {'id': 'header', 'href': 'header.xml', 'media-type': 'application/xml'})
    ET.SubElement(manifest, tag(OPF, 'item'), {'id': 'section0', 'href': 'section0.xml', 'media-type': 'application/xml'})
    spine = ET.SubElement(content, tag(OPF, 'spine'))
    ET.SubElement(spine, tag(OPF, 'itemref'), {'idref': 'header'})
    ET.SubElement(spine, tag(OPF, 'itemref'), {'idref': 'section0'})
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('mimetype', 'application/hwp+zip', compress_type=zipfile.ZIP_STORED)
        archive.writestr('version.xml', '<?xml version="1.0" encoding="UTF-8"?><HWPVersion major="5" minor="0" micro="0" buildNumber="0"/>')
        archive.writestr('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></rootfiles></container>')
        archive.writestr('Contents/content.hpf', xml_bytes(content))
        archive.writestr('Contents/header.xml', xml_bytes(header))
        archive.writestr('Contents/section0.xml', xml_bytes(section))


def sections(archive):
    """Body parts in reading order: META-INF/container.xml → package (content.hpf) → manifest ⊕ spine.
    Only a package without that structure falls back to the Contents/sectionN.xml file names (review R3)."""
    names = set(archive.namelist())
    try:
        container = ET.fromstring(archive.read('META-INF/container.xml'))
        rootfile = container.find('.//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile')
        package_path = rootfile.attrib['full-path'] if rootfile is not None else None
    except (KeyError, ET.ParseError):
        package_path = None
    if package_path and package_path in names:
        package = ET.fromstring(archive.read(package_path))
        opf = '{http://www.idpf.org/2007/opf/}'
        manifest_node = package.find(opf + 'manifest')
        spine_node = package.find(opf + 'spine')
        if manifest_node is not None and spine_node is not None:
            manifest = {item.attrib.get('id'): item.attrib.get('href', '') for item in manifest_node}
            base = posixpath.dirname(package_path)
            ordered = []
            for ref in spine_node:
                href = manifest.get(ref.attrib.get('idref'))
                if not href:
                    continue
                candidates = [posixpath.normpath(posixpath.join(base, href)), posixpath.normpath(href)]
                path = next((c for c in candidates if c in names), None)
                if path is None:
                    continue
                try:
                    if ET.fromstring(archive.read(path)).tag.endswith('}sec'):
                        ordered.append(path)
                except ET.ParseError:
                    continue
            if ordered:
                return ordered
    paths = sorted((p for p in names if re.fullmatch(r'Contents/section\d+\.xml', p)), key=lambda p: int(re.search(r'\d+', p).group()))
    if not paths:
        failure('HWPX 에 본문(section)이 없습니다 — content.hpf spine 에도, Contents/section*.xml 에도 없다.')
    return paths


def text_of(node):
    return ''.join(t.text or '' for t in node.iter(tag(HP, 't')))


def markdown_from_hwpx(path):
    with zipfile.ZipFile(path) as archive:
        pieces = []
        for section_path in sections(archive):
            root = ET.fromstring(archive.read(section_path))
            for p in root.findall(tag(HP, 'p')):
                for table in p.findall('.//' + tag(HP, 'tbl')):
                    rows = []
                    for tr in table.findall(tag(HP, 'tr')):
                        rows.append([text_of(tc).replace('\\', '\\\\').replace('|', '\\|') for tc in tr.findall(tag(HP, 'tc'))])
                    if rows:
                        table_lines = ['| ' + ' | '.join(rows[0]) + ' |',
                                       '| ' + ' | '.join('---' for _ in rows[0]) + ' |']
                        table_lines.extend('| ' + ' | '.join(row) + ' |' for row in rows[1:])
                        pieces.append('\n'.join(table_lines))
                runs = [run for run in p.findall(tag(HP, 'run')) if run.find(tag(HP, 'tbl')) is None]
                text = ''.join(('**' + text_of(run) + '**') if run.attrib.get('charPrIDRef') == '1' and text_of(run) else text_of(run) for run in runs).strip()
                if text:
                    style = int(p.attrib.get('paraPrIDRef', '0'))
                    pieces.append(('#' * style + ' ' if 1 <= style <= 6 else '') + text)
        return '\n\n'.join(pieces) + ('\n' if pieces else '')


def read_hwp(path):
    try:
        proc = subprocess.run(['hwp5txt', str(path)], capture_output=True, text=True, check=False)
    except FileNotFoundError:
        failure('HWP 5.0 읽기에는 pyhwp 가 필요합니다. elanous venv에서 python -m pip install pyhwp 를 실행하세요.')
    if proc.returncode:
        failure('hwp5txt 변환 실패: ' + proc.stderr.strip()[:300])
    return proc.stdout


def replace_fields(root, fields):
    count = 0
    for p in root.iter(tag(HP, 'p')):
        # A placeholder can cross styled runs; replace only within the same paragraph.
        runs = [run for run in p.findall(tag(HP, 'run')) if run.find(tag(HP, 'tbl')) is None]
        nodes = [t for run in runs for t in run.iter(tag(HP, 't'))]
        if not nodes:
            continue
        combined = ''.join(t.text or '' for t in nodes)
        pattern = re.compile(r'\{\{([^{}]+)\}\}')
        matches = list(pattern.finditer(combined))
        if not matches:
            continue
        offsets = []
        cursor = 0
        for node in nodes:
            offsets.append((cursor, cursor + len(node.text or '')))
            cursor += len(node.text or '')
        for match in reversed(matches):
            key = match[1].strip()
            if key not in fields:
                failure('채울 값이 없는 자리표시: ' + key)
            first = next(i for i, (_, end) in enumerate(offsets) if end > match.start())
            last = next(i for i, (_, end) in enumerate(offsets) if end >= match.end())
            start = match.start() - offsets[first][0]
            end = match.end() - offsets[last][0]
            prefix = (nodes[first].text or '')[:start]
            suffix = (nodes[last].text or '')[end:]
            nodes[first].text = prefix + fields[key] + (suffix if first == last else '')
            for index in range(first + 1, last + 1):
                nodes[index].text = suffix if index == last else ''
            count += 1
    return count


def page_count(archive):
    # Explicit page breaks are checkable without relying on an unavailable layout engine.
    return sum(1 + sum(p.get('pageBreak') == '1' for p in ET.fromstring(archive.read(name)).iter(tag(HP, 'p')))
               for name in sections(archive))


def fill_hwpx(source, output, fields):
    safe_target(source, output)
    with zipfile.ZipFile(source) as source_zip:
        paths = sections(source_zip)
        before = page_count(source_zip)
        changed = {}
        total = 0
        for name in paths:
            root = ET.fromstring(source_zip.read(name))
            total += replace_fields(root, fields)
            changed[name] = xml_bytes(root)
        if not total:
            failure('채울 자리표시가 없습니다.')
        # Preserve all original ZIP members, ordering, metadata and untouched XML bytes.
        with zipfile.ZipFile(output, 'w') as dest:
            for info in source_zip.infolist():
                dest.writestr(copy.copy(info), changed.get(info.filename, source_zip.read(info.filename)))
    with zipfile.ZipFile(output) as filled:
        after = page_count(filled)
    if after != before:
        Path(output).unlink()
        failure('페이지 수가 달라졌습니다.')
    return total, before


def main(argv=None):
    parser = argparse.ArgumentParser(description='HWP/HWPX 읽기·쓰기·양식 채우기 (JSON 출력)')
    sub = parser.add_subparsers(dest='command', required=True)
    reader = sub.add_parser('read')
    reader.add_argument('path')
    writer = sub.add_parser('write')
    writer.add_argument('path', help='UTF-8 Markdown 파일')
    writer.add_argument('--template', default='report', choices=('report', 'official-letter'))
    writer.add_argument('-o', '--output', required=True)
    filler = sub.add_parser('fill')
    filler.add_argument('path')
    filler.add_argument('--fields', required=True, help='자리표시 이름 → 문자열의 UTF-8 JSON 파일')
    filler.add_argument('-o', '--output', required=True)
    args = parser.parse_args(argv)
    try:
        source = Path(args.path)
        if not source.is_file():
            failure('입력 파일이 없습니다: ' + str(source))
        if args.command == 'read':
            if source.suffix.lower() == '.hwpx':
                result = {'markdown': markdown_from_hwpx(source)}
            elif source.suffix.lower() == '.hwp':
                result = {'markdown': read_hwp(source)}
            else:
                failure('지원 형식은 .hwp, .hwpx 입니다.')
        else:
            output = Path(args.output)
            safe_target(source, output)
            if args.command == 'write':
                if output.suffix.lower() != '.hwpx':
                    failure('쓰기 출력 형식은 .hwpx 입니다.')
                header, section = build_hwpx(source.read_text(encoding='utf-8'), template_for(args.template))
                write_hwpx(output, header, section)
                result = {'output': str(output), 'template': args.template}
            else:
                if source.suffix.lower() != '.hwpx' or output.suffix.lower() != '.hwpx':
                    failure('양식 입력·출력은 .hwpx 여야 합니다.')
                fields = json.loads(Path(args.fields).read_text(encoding='utf-8'))
                if not isinstance(fields, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in fields.items()):
                    failure('fields 는 문자열 키·문자열 값의 JSON 객체여야 합니다.')
                count, pages = fill_hwpx(source, output, fields)
                result = {'output': str(output), 'filled': count, 'pagesBefore': pages, 'pagesAfter': pages}
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, zipfile.BadZipFile, ET.ParseError, UnicodeError, json.JSONDecodeError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
