#!/usr/bin/env python3
"""Render reviewed facts into both pages; --check rejects stale or unknown facts."""
import argparse
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = [ROOT / 'lakebase-objection-faq/index.html', ROOT / 'lakebase-compete-calculator/index.html']
TOKEN = re.compile(r'<span data-fact="([a-z.]+)">([^<]*)</span>')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    source = json.loads((ROOT / 'lakebase-content/facts.json').read_text())
    facts, parameters = source['facts'], source['parameters']
    used, stale = set(), []
    for page in PAGES:
        text = page.read_text()
        def render(match):
            key = match[1]
            if key not in facts:
                raise ValueError(f'Unknown fact {key} in {page}')
            used.add(key)
            fact = facts[key]
            if not fact['source'].startswith('https://') or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', fact['checked']):
                raise ValueError(f'Invalid provenance for {key}')
            value = fact['template'].format_map(parameters) if 'template' in fact else fact['value']
            return f'<span data-fact="{key}">{html.escape(value, quote=False)}</span>'
        rendered = TOKEN.sub(render, text)
        if rendered != text:
            stale.append(str(page.relative_to(ROOT)))
            if not args.check:
                page.write_text(rendered)
    if used != set(facts):
        raise ValueError(f'Unused facts: {sorted(set(facts) - used)}')
    if stale and args.check:
        raise SystemExit('Stale facts; run python3 lakebase-content/render_facts.py: ' + ', '.join(stale))
    print(f'PASS: {len(used)} reviewed facts in {len(PAGES)} pages' if args.check else 'Rendered: ' + (', '.join(stale) or 'already current'))


if __name__ == '__main__':
    main()
