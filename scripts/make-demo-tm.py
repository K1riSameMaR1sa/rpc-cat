# -*- coding: utf-8 -*-
"""
scripts/make-demo-tm.py — carve a small demo memory out of the full TMX.

The shipped RPC Authority memory is ~21 MB, far too large to commit.  This
builds data/demo-tm.tmx (a few hundred units across a spread of documents) so
the app is usable straight from GitHub Pages, while the full file stays a local
import.

Usage:
    python scripts/make-demo-tm.py path/to/RPC_Authority_EN-ZH.tmx
"""
import re
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'demo-tm.tmx')

MAX_DOCS = 30
PER_DOC = 22
MIN_SCORE = 0.80


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src or not os.path.exists(src):
        print('usage: python scripts/make-demo-tm.py <full.tmx>')
        return 1

    text = open(src, encoding='utf-8').read()
    body_start = text.index('<body>')
    header = text[:body_start]
    body = text[body_start:]

    # split the body into <tu> blocks, keeping them byte-exact so escaping,
    # props and tuids all survive untouched
    blocks = re.findall(r'  <tu\b.*?</tu>\n', body, re.S)
    print(f'parsed {len(blocks):,} translation units from {os.path.basename(src)}')

    by_doc = defaultdict(list)
    for b in blocks:
        m = re.search(r'<prop type="x-doc">(.*?)</prop>', b)
        doc = m.group(1) if m else '?'
        s = re.search(r'<prop type="x-seg-score">([0-9.]+)</prop>', b)
        score = float(s.group(1)) if s else 0.0
        if score >= MIN_SCORE:
            by_doc[doc].append((score, b))

    # prefer documents that contribute a decent number of clean units
    ranked = sorted(by_doc.items(), key=lambda kv: -len(kv[1]))[:MAX_DOCS]

    chosen = []
    for doc, items in ranked:
        items.sort(key=lambda x: -x[0])
        # even spread rather than only the very top scores
        step = max(1, len(items) // PER_DOC)
        picked = items[::step][:PER_DOC]
        chosen.extend(picked)

    chosen.sort(key=lambda x: -x[0])
    print(f'selected {len(chosen)} units from {len(ranked)} documents')

    # rebuild the header with demo-appropriate notes
    new_header = header
    new_header = re.sub(r'creationdate="[^"]*"', 'creationdate="20260101T000000Z"', new_header)
    new_header = new_header.replace(
        '<prop type="Project">',
        '<prop type="Project">RPC Authority EN-ZH translation memory (demo subset)</prop>\n'
        '  <prop type="Note">Demo subset included with RPC CAT. '
        'Import the full memory via the app.</prop>\n'
        '  <prop type="Ignored-Project">', 1)

    out = [new_header, '<body>\n']
    out.extend(b for _, b in chosen)
    out.append('</body>\n</tmx>\n')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(''.join(out))

    size = os.path.getsize(OUT)
    print(f'wrote {OUT} ({size/1024:.0f} KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
