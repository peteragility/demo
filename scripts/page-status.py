#!/usr/bin/env python3
"""Publish small per-workflow status files for the homepage, without downloading full datasets."""
import argparse
from datetime import datetime
import json
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent


def day(value):
    if not value: return None
    if len(value) == 10: return value
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Hong_Kong')).date().isoformat()


def build(group, data, previous):
    if group == 'content': return {'schema': 1, 'pages': data['pages']}
    if group == 'llm':
        paths = ['llm-pricing/']; checked = data['checked_at']
        errors = len(data.get('sources_failed', [])) + bool(data.get('ranking', {}).get('error'))
        review = len(data.get('review', [])) + len(data.get('pending_general', [])) + len(data.get('databricks_coverage', []))
    elif group == 'lakebase':
        paths = ['lakebase-compete-calculator/', 'lakebase-field-guide/']; checked = data['checked']
        errors = len(data['errors']); review = len(data['findings'])
    elif group == 'security':
        paths = ['security-risk/']; checked = day(data['last_attempt'])
        errors = sum(s['status'] != 'ok' for s in data['sources']); review = sum(bool(r.get('source_changed')) for r in data['records'])
    else: raise ValueError('Unknown status group')
    pages = {}
    for path in paths:
        last = day(data.get('last_success')) if group == 'security' else previous.get('pages', {}).get(path, {}).get('lastSuccess') if errors else checked
        pages[path] = {'checkedAt': checked, 'lastSuccess': last, 'errors': int(errors), 'review': review, 'status': 'partial' if errors else 'review' if review else 'ok'}
    return {'schema': 1, 'pages': pages}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('group', choices=['llm', 'lakebase', 'security', 'content'])
    p.add_argument('--report', type=Path)
    args = p.parse_args()
    files = {'llm': 'llm-pricing/v2-checks.json', 'security': 'security-risk/data.json', 'content': 'content-watch/checks.json'}
    source = args.report or ROOT / files[args.group]
    target = ROOT / 'page-status' / (args.group + '.json')
    prior = json.loads(target.read_text()) if target.exists() else {}
    status = build(args.group, json.loads(source.read_text()), prior)
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(status, indent=2) + '\n')
