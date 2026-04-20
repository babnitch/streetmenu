#!/usr/bin/env python3
"""Safer codemod: rewrites hardcoded 'French / English' pairs to bi(fr,en)
calls ONLY in positions that are inside React components (JSX text and
JSX attribute values). Module-scope object-literal values are left alone
— callers wrap those in pickBi(str, locale) at the read site instead,
because bi() is a hook and can't be called in module scope.

Idempotent — re-running is a no-op once all lines are converted.

Positions handled:
  1. JSX attribute: title="FR / EN"  → title={bi('FR', 'EN')}
  2. JSX text node: >FR / EN<        → >{bi('FR', 'EN')}<

Positions deliberately skipped:
  - Object-literal values (module-scope risk)
  - Function call args (may be outside render)
  - Backtick template literals

Auto-adds `import { useBi } from '@/lib/languageContext'` and a
`const bi = useBi()` call inside the default-export function when a
replacement happens.
"""
import re, sys
from pathlib import Path

_UPPER_LATIN = re.compile(r"[A-ZÀ-ÖØ-ÞÉÈÊÇ]")

def looks_bilingual(fr: str, en: str) -> bool:
    """Heuristic: both sides must have at least one uppercase latin letter
    and be 1–80 chars each. Avoids matching numeric fractions ("1/10"),
    URLs with spaces, and a/b style filler while still catching
    emoji-prefixed UI labels ("✅ Approuver / Approve")."""
    fr = fr.strip(); en = en.strip()
    if not fr or not en: return False
    if len(fr) > 80 or len(en) > 80: return False
    if '<' in fr or '>' in fr or '{' in fr or '}' in fr: return False
    if '<' in en or '>' in en or '{' in en or '}' in en: return False
    if not _UPPER_LATIN.search(fr): return False
    if not _UPPER_LATIN.search(en): return False
    return True

def escape_single(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")

def process_line(line: str) -> str:
    # 1. JSX attribute  name="FR / EN"
    def attr_dq(m):
        pre, fr, en = m.group(1), m.group(2).strip(), m.group(3).strip()
        if looks_bilingual(fr, en):
            return f"{pre}={{bi('{escape_single(fr)}', '{escape_single(en)}')}}"
        return m.group(0)
    line = re.sub(
        r'([a-zA-Z-]+)="([^"<>{}\n]+?)\s*/\s*([^"<>{}\n]+?)"',
        attr_dq, line,
    )

    # 2. JSX text between tags:  >FR / EN<
    def between_tags(m):
        fr, en = m.group(1).strip(), m.group(2).strip()
        if looks_bilingual(fr, en):
            return f">{{bi('{escape_single(fr)}', '{escape_single(en)}')}}<"
        return m.group(0)
    line = re.sub(
        r'>([^<>{}\n]+?)\s*/\s*([^<>{}\n]+?)<',
        between_tags, line,
    )

    # 3. Function-call arg string: f('FR / EN') or f(x, 'FR / EN', y)
    #    Preceding char must be `(` , `,` or whitespace — avoids matching
    #    property shorthand like {foo:'x/y'}.
    def fn_arg_s(m):
        pre, fr, en = m.group(1), m.group(2).strip(), m.group(3).strip()
        if looks_bilingual(fr, en):
            return f"{pre}bi('{escape_single(fr)}', '{escape_single(en)}')"
        return m.group(0)
    line = re.sub(
        r"([(\s,])'([^'<>{}\n]+?)\s*/\s*([^'<>{}\n]+?)'",
        fn_arg_s, line,
    )
    # Same for double-quoted args.
    line = re.sub(
        r'([(\s,])"([^"<>{}\n]+?)\s*/\s*([^"<>{}\n]+?)"',
        fn_arg_s, line,
    )

    return line

def ensure_import(src: str) -> str:
    if re.search(r"\buseBi\b", src):
        return src
    m = re.search(r"import\s+\{([^}]+)\}\s+from\s+['\"]@/lib/languageContext['\"]", src)
    if m:
        names = [n.strip() for n in m.group(1).split(',') if n.strip()]
        if 'useBi' not in names:
            names.append('useBi')
        return src.replace(m.group(0), "import { " + ', '.join(names) + " } from '@/lib/languageContext'")
    imports = list(re.finditer(r"^import .*$", src, flags=re.M))
    if imports:
        last = imports[-1]
        return src[:last.end()] + "\nimport { useBi } from '@/lib/languageContext'" + src[last.end():]
    return src

def ensure_hook(src: str) -> str:
    if re.search(r"\bconst\s+bi\s*=\s*useBi\(\)", src):
        return src
    m = re.search(r"export default function \w+\s*\([^)]*\)\s*\{", src)
    if not m:
        return src
    insert_at = m.end()
    return src[:insert_at] + "\n  const bi = useBi()" + src[insert_at:]

def process_file(path: Path) -> int:
    src = path.read_text()
    out_lines = []
    changed = 0
    for line in src.split('\n'):
        new = process_line(line)
        if new != line: changed += 1
        out_lines.append(new)
    if changed == 0: return 0
    new_src = '\n'.join(out_lines)
    new_src = ensure_import(new_src)
    new_src = ensure_hook(new_src)
    path.write_text(new_src)
    return changed

if __name__ == '__main__':
    targets = sys.argv[1:]
    if not targets:
        print("usage: dedup-bilingual.py <file> [<file> …]")
        sys.exit(1)
    for t in targets:
        print(f"{t}: {process_file(Path(t))} replacements")
