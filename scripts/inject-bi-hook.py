#!/usr/bin/env python3
"""Ensures every React component (function starting with a capital letter)
that calls `bi(` has a `const bi = useBi()` line at the top of its body.
Handles multi-line signatures. Idempotent.

Skips lowercase-named helpers (they shouldn't use bi — if they do, it's
a mismigration).
"""
import re, sys
from pathlib import Path

HEADER_RE = re.compile(r"(?:export default )?function ([A-Z]\w*)\s*\(", re.M)

def match_parens(src: str, start: int, open_c: str, close_c: str) -> int:
    """Given the index of an opening bracket in src, return the index of
    the matching closing bracket. Handles strings and comments naïvely —
    good enough for typical TSX."""
    depth = 0
    i = start
    in_str = False; str_ch = ''
    in_line_comment = False
    in_block_comment = False
    while i < len(src):
        c = src[i]
        two = src[i:i+2]
        if in_line_comment:
            if c == '\n': in_line_comment = False
            i += 1; continue
        if in_block_comment:
            if two == '*/': in_block_comment = False; i += 2; continue
            i += 1; continue
        if in_str:
            if c == '\\': i += 2; continue
            if c == str_ch: in_str = False
            i += 1; continue
        if two == '//': in_line_comment = True; i += 2; continue
        if two == '/*': in_block_comment = True; i += 2; continue
        if c in ('"', "'", '`'):
            in_str = True; str_ch = c; i += 1; continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0: return i
        i += 1
    return -1

def process(src: str) -> str:
    out = []
    cursor = 0
    for m in HEADER_RE.finditer(src):
        out.append(src[cursor:m.end()])
        paren_open = m.end() - 1
        paren_close = match_parens(src, paren_open, '(', ')')
        if paren_close < 0:
            cursor = m.end(); continue
        # After the closing paren, there may be a TS return-type annotation.
        # Find the opening brace of the function body.
        i = paren_close + 1
        brace_open = -1
        while i < len(src):
            if src[i] == '{':
                brace_open = i; break
            if src[i] == ';':  # declaration-only, no body
                break
            i += 1
        if brace_open < 0:
            cursor = m.end(); continue
        brace_close = match_parens(src, brace_open, '{', '}')
        if brace_close < 0:
            cursor = m.end(); continue

        # Emit parens + any return-type annotation + opening brace.
        out.append(src[m.end():brace_open+1])

        body = src[brace_open+1:brace_close]
        if 'bi(' in body and 'const bi = useBi()' not in body:
            out.append('\n  const bi = useBi()')
        out.append(body)
        out.append('}')
        cursor = brace_close + 1
    out.append(src[cursor:])
    return ''.join(out)

if __name__ == '__main__':
    for p in sys.argv[1:]:
        path = Path(p)
        src = path.read_text()
        new = process(src)
        if new != src:
            path.write_text(new)
            print(f"{p}: hooks injected")
        else:
            print(f"{p}: no change")
