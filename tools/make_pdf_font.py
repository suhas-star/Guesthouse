"""Build assets/inter_pdf.json: Inter Regular + SemiBold (printable ASCII only) for the booking voucher PDF.
Inter by Rasmus Andersson, SIL Open Font License 1.1 (https://openfontlicense.org).
Usage: python3 tools/make_pdf_font.py inter-400.ttf inter-600.ttf   (files from Google Fonts with &text= the ASCII range)"""
import base64, json, sys
from fontTools.ttLib import TTFont

def pack(path, name):
    f = TTFont(path); upm = f['head'].unitsPerEm; cm = f.getBestCmap(); hm = f['hmtx'].metrics; os2 = f['OS/2']
    sc = lambda v: round(v * 1000 / upm)
    widths = [sc(hm[cm[c]][0]) if c in cm else 0 for c in range(32, 127)]
    xs = [f['glyf'][g] for g in f.getGlyphOrder()]
    bbox = [min(getattr(g, 'xMin', 0) for g in xs), min(getattr(g, 'yMin', 0) for g in xs), max(getattr(g, 'xMax', 0) for g in xs), max(getattr(g, 'yMax', 0) for g in xs)]
    return {'name': name, 'widths': widths, 'bbox': [sc(v) for v in bbox], 'ascent': sc(os2.sTypoAscender), 'descent': sc(os2.sTypoDescender), 'cap': sc(getattr(os2, 'sCapHeight', 700)),
            'data': base64.b64encode(open(path, 'rb').read()).decode()}

out = {'license': 'Inter by Rasmus Andersson, SIL Open Font License 1.1', 'regular': pack(sys.argv[1], 'Inter-Regular'), 'bold': pack(sys.argv[2], 'Inter-SemiBold')}
json.dump(out, open('assets/inter_pdf.json', 'w'), separators=(',', ':'))
print('ok', len(out['regular']['data']) + len(out['bold']['data']))
