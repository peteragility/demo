#!/usr/bin/env python3
"""Observe sizing prices/availability and sandbox claims; keep findings until reviewed."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from decimal import Decimal, InvalidOperation
import hashlib
import importlib.util
import json
from pathlib import Path
import re
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
HERE = ROOT / 'content-watch'
spec = importlib.util.spec_from_file_location('source_review', ROOT / 'llm-pricing/v2-maintenance/review-sources.py')
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
SIGNAL = re.compile(r'isolat|microvm|virtual machine|\bvm\b|kernel|gvisor|firecracker|credential|secret|sandbox|\$|pricing|bill|preview|availability|available|region|limit|deprecated', re.I)


def number(value):
    try:
        values = [Decimal(x.strip()) for x in str(value).split('|')]
        if not values or any(not x.is_finite() or x < 0 for x in values): raise ValueError('Invalid rate')
        return '|'.join(str(x.normalize()) for x in values)
    except (InvalidOperation, ValueError):
        raise ValueError('Invalid rate') from None


def rates(document, bundle, live=False):
    result = {}
    for tier, clouds in bundle['rates'].items():
        for cloud, skus in clouds.items():
            for sku, saved in skus.items():
                table = (document if live else document['rates']).get(tier, {}).get(cloud, {}).get(sku)
                if not isinstance(table, dict): raise ValueError(f'Missing price table {tier}/{cloud}/{sku}')
                for region in set(saved) | set(table):
                    result[f'{tier}/{cloud}/{sku}/{region}'] = number(table[region]) if region in table else 'MISSING'
    for cloud, models in bundle['models'].items():
        for model, saved in models.items():
            table = document.get('regionModels', {}).get(cloud, {}).get('on_demand', {}).get(model) if live else document['models'][cloud].get(model)
            if not isinstance(table, dict): raise ValueError(f'Missing model table {cloud}/{model}')
            for region in set(saved) | set(table):
                for part in ['inputPrice', 'outputPrice']:
                    value = table.get(region, {}).get(part)
                    result[f'models/{cloud}/{model}/{region}/{part}'] = number(value) if value is not None else 'MISSING'
    return result


def records(text, source, bundle):
    kind = source.get('kind', 'html')
    if kind == 'prices': return rates(json.loads(text), bundle, live=True)
    if kind == 'markdown' or text.lstrip().startswith('# '):
        rows = [shared.clean(line) for line in text.splitlines() if SIGNAL.search(line) and not line.startswith(('#', '<'))]
    else:
        page = shared.official.Page(); page.feed(text); page.close()
        if kind == 'availability':
            rows = [' | '.join(row) for table in page.tables if re.search('region|availab', table['heading'], re.I) for row in table['rows']]
            rows += [p for p, h in zip(page.paragraphs, page.paragraph_headings) if re.search('region|availab', h, re.I)]
        else:
            rows = [p for p in page.paragraphs if SIGNAL.search(p)]
    result = sorted(set(shared.clean(row) for row in rows if len(row.strip()) >= 10))
    if not result: raise ValueError('No meaningful source records; review the parser')
    return {hashlib.sha256(row.encode()).hexdigest(): row for row in result}


def compare(source, observed, previous, bundle):
    if source.get('kind') == 'prices':
        expected = rates(bundle, bundle)
        diff = [f'{k}: bundled {expected.get(k, "not listed")} → source {observed.get(k, "missing")}' for k in sorted(expected.keys() | observed.keys()) if expected.get(k) != observed.get(k)]
        return diff  # A baseline reset cannot conceal a stale published price snapshot.
    if not previous or previous.get('url') != source['url']:
        return ['New source or URL requires a reviewed observation baseline.']
    before, after = set(previous['records']), set(observed)
    added = sorted(after - before)
    return ['Removed record: ' + x for x in sorted(before - after)] + ['Added record: ' + x + (': ' + observed[x][:150] if i < 4 else '') for i, x in enumerate(added)]


def run(args):
    config = json.loads((HERE / 'sources.json').read_text())
    bundle = json.loads((ROOT / 'databricks-sizing/pricing-snapshot.json').read_text())
    baseline = json.loads(args.baseline.read_text()) if args.baseline.exists() else {'sources': {}}
    old = json.loads(args.checks.read_text()) if args.checks.exists() else {'pages': {}}
    now = datetime.now(ZoneInfo('Asia/Hong_Kong')).date().isoformat()
    def read(source):
        try:
            text = (args.cache_dir / (source['id'] + '.txt')).read_text() if args.cache_dir else shared.read_url(source['url'], attempts=2)
            return source, records(text, source, bundle), None
        except Exception as error: return source, None, str(error)[:300]
    with ThreadPoolExecutor(max_workers=6) as pool: observations = list(pool.map(read, config))
    if args.record_baseline and any(error for _, _, error in observations):
        print('Baseline refused: some sources could not be read.')
    elif args.record_baseline:
        baseline = {'observed': now, 'sources': {s['id']: {'url': s['url'], 'records': value if s.get('kind') == 'prices' else sorted(value)} for s, value, _ in observations}}
        args.baseline.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + '\n')
    findings, pages = [], {}
    for source, value, error in observations:
        page = pages.setdefault(source['page'], {'checkedAt': now, 'lastSuccess': old['pages'].get(source['page'], {}).get('lastSuccess'), 'errors': 0, 'review': 0, 'sources': 0})
        page['sources'] += 1
        changes = [] if error else compare(source, value, baseline.get('sources', {}).get(source['id']), bundle)
        if error or changes:
            page['errors' if error else 'review'] += 1
            findings.append({'id': source['id'], 'url': source['url'], 'page': source['page'], 'error': error, 'changes': changes})
    for page in pages.values():
        if not page['errors']: page['lastSuccess'] = now
        page['status'] = 'partial' if page['errors'] else 'review' if page['review'] else 'ok'
    args.checks.parent.mkdir(parents=True, exist_ok=True)
    args.checks.write_text(json.dumps({'schema': 1, 'checkedAt': now, 'pages': pages, 'findings': findings}, ensure_ascii=False, indent=2) + '\n')
    args.report_dir.mkdir(parents=True, exist_ok=True)
    lines = [f'Sizing and sandbox source review {now}', '', 'Review changed rates, availability or claims before updating the snapshot or accepting a new baseline.', '']
    for finding in findings:
        lines.append(f"- [{finding['id']}]({finding['url']}): " + (finding['error'] or f"{len(finding['changes'])} changed records"))
        lines.extend('  - ' + re.sub(r'[\r\n`]', ' ', change)[:400] for change in finding['changes'][:12])
    (args.report_dir / 'issue.md').write_text('\n'.join(lines) + '\n' if findings else '')
    (args.report_dir / 'report.json').write_text(args.checks.read_text())
    print(f'{len(config)} sources; {len(findings)} findings; {sum(p["errors"] for p in pages.values())} errors')
    return 1 if any(p['errors'] for p in pages.values()) else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-baseline', action='store_true')
    parser.add_argument('--baseline', type=Path, default=HERE / 'baseline.json')
    parser.add_argument('--checks', type=Path, default=HERE / 'checks.json')
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--report-dir', type=Path, required=True)
    raise SystemExit(run(parser.parse_args()))
