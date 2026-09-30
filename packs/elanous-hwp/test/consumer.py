"""Independent OPF/HWPX package consumer for testing generated archives."""
import json
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

OPF = '{http://www.idpf.org/2007/opf/}'
HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
ODF = '{urn:oasis:names:tc:opendocument:xmlns:container}'

with zipfile.ZipFile(sys.argv[1]) as archive:
    container = ET.fromstring(archive.read('META-INF/container.xml'))
    package_path = container.find('.//' + ODF + 'rootfile').attrib['full-path']
    package = ET.fromstring(archive.read(package_path))
    manifest = {item.attrib['id']: item.attrib['href'] for item in package.find(OPF + 'manifest')}
    spine = [item.attrib['idref'] for item in package.find(OPF + 'spine')]
    paths = [posixpath.normpath(posixpath.join(posixpath.dirname(package_path), manifest[item])) for item in spine]
    roots = [ET.fromstring(archive.read(path)) for path in paths]
    section = next(root for root in roots if root.tag == HP + 'sec')
    text = ''.join(node.text or '' for node in section.iter(HP + 't'))
    cells = [''.join(node.text or '' for node in cell.iter(HP + 't')) for cell in section.iter(HP + 'tc')]
    tables = sum(1 for _ in section.iter(HP + 'tbl'))
    print(json.dumps({'paths': paths, 'text': text, 'cells': cells, 'tables': tables}, ensure_ascii=False))
