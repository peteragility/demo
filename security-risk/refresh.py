#!/usr/bin/env python3
"""Refresh a public security watchlist. Standard library only; never scan user assets."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
KEV = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'
FEEDS = {
    'node': ('Node.js security releases', 'https://nodejs.org/en/feed/vulnerability.xml', 'runtime', 'Node.js'),
    'php': ('PHP security releases', 'https://www.php.net/releases/feed.php', 'runtime', 'PHP'),
    'gitlab': ('GitLab patch releases', 'https://docs.gitlab.com/releases/patch-releases.xml', 'delivery', 'GitLab'),
    'ca': ('Google Security / certificate incidents', 'https://blog.google/security/rss/', 'trust', 'Web PKI'),
}
LAYERS = {'trust', 'edge', 'runtime', 'delivery', 'system', 'identity'}
ANCHORS = {'CVE-2024-4577', 'CVE-2021-22205', 'CVE-2023-7028', 'CVE-2024-6387',
           'CVE-2024-3094', 'CVE-2021-44228', 'CVE-2024-1086', 'CVE-2024-3400',
           'CVE-2023-4966', 'CVE-2025-29927'}
ATOM = {'a': 'http://www.w3.org/2005/Atom', 'p': 'http://php.net/ns/releases'}


class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.ignore = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'nav', 'footer', 'header'): self.ignore += 1
        if tag in ('p', 'div', 'li', 'h1', 'h2', 'h3', 'br', 'tr'): self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'nav', 'footer', 'header'): self.ignore = max(0, self.ignore - 1)
        if tag in ('p', 'li', 'h1', 'h2', 'h3', 'tr'): self.parts.append('\n')

    def handle_data(self, data):
        if not self.ignore: self.parts.append(data)


def plain(value):
    parser = Text(); parser.feed(str(value or ''))
    return re.sub(r'[ \t]+', ' ', html.unescape(''.join(parser.parts))).strip()


def safe_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        return parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password
    except ValueError:
        return False


def fetch(url, as_json=False):
    if not safe_url(url): raise ValueError('Only HTTPS sources are accepted')
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'DemoLab-SecurityChecklist/1.0', 'Accept': 'application/json, application/xml, text/html, */*'})
            with urllib.request.urlopen(req, timeout=25) as response:
                if not safe_url(response.url): raise ValueError('Unsafe redirect')
                data = response.read(12_000_001)
                if len(data) > 12_000_000: raise ValueError('Source exceeds size limit')
            return json.loads(data) if as_json else data.decode('utf-8', errors='replace')
        except (OSError, ValueError) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 404: raise
            if attempt == 2: raise
            time.sleep(attempt + 1)


def layer_for(product):
    for pattern, layer in [
        (r'openssl|certificate|cryptoapi', 'trust'),
        (r'gitlab|jenkins|bamboo|teamcity|bitbucket|npm|supply.chain|xz utils', 'delivery'),
        (r'php|node.js|struts|spring|log4j|react|next.js|django|laravel|ruby|python|tomcat', 'runtime'),
        (r'forti|ivanti|cisco|pan-os|palo alto|net[sS]caler|citrix|vpn|sonicwall|f5|big-ip|nginx|apache http|bind|zyxel', 'edge'),
        (r'windows|linux|kernel|docker|kubernetes|vmware|esxi|openssh|sudo|polkit', 'system'),
    ]:
        if re.search(pattern, product, re.I): return layer
    return 'identity'


def impact_for(text):
    text = text.lower()
    for pattern, label in [
        (r'code execution|command injection|execute.{0,35}(code|command)|deserializ', 'Code execution'),
        (r'authentication bypass|improper authentication|auth.*bypass', 'Auth bypass'),
        (r'privilege|elevation', 'Privilege escalation'),
        (r'denial.of.service|resource consumption', 'Denial of service'),
        (r'(credential|password|token).{0,35}(theft|disclos|leak|expos)|session hijack|session fixation', 'Credential / session theft'),
        (r'file|disclos|information|traversal|sql injection|ssrf|server.side request forgery', 'Data / file access'),
    ]:
        if re.search(pattern, text): return label
    return 'See advisory'


def cve_id(value):
    return bool(re.fullmatch(r'CVE-\d{4}-\d{4,8}', value))


def stamp():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def kev_records(data, now, keep=()):
    items = data.get('vulnerabilities')
    if not isinstance(items, list) or len(items) < 100: raise ValueError('Incomplete KEV catalog')
    # Recent catalog additions across all products, plus enduring high-impact examples.
    ordered = sorted(items, key=lambda r: r.get('dateAdded', ''), reverse=True)
    selected = {r['cveID']: r for r in ordered[:45]}
    for layer in LAYERS:
        matches = [r for r in ordered if layer_for(r['vendorProject'] + ' ' + r['product']) == layer]
        for r in matches[:4]: selected[r['cveID']] = r
    for r in ordered:
        if r['cveID'] in ANCHORS or r['cveID'] in keep: selected[r['cveID']] = r
    result = []
    for r in selected.values():
        if not cve_id(r['cveID']): raise ValueError('Invalid CVE in catalog')
        product = r['vendorProject'] + ' ' + r['product']
        links = [{'label': 'CISA KEV', 'url': 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=' + r['cveID']},
                 {'label': 'CVE record', 'url': 'https://www.cve.org/CVERecord?id=' + r['cveID']}]
        result.append(dict(id=r['cveID'], title=r['vulnerabilityName'], product=product, layer=layer_for(product),
                           description=r['shortDescription'], impact=impact_for(r['vulnerabilityName'] + ' ' + r['shortDescription']),
                           action=r['requiredAction'], affected=[], fixed=[], conditions=[], sources=links,
                           source_id='kev', kev=True, kev_added=r['dateAdded'], ransomware=r.get('knownRansomwareCampaignUse') == 'Known',
                           published='', updated='', checked_at=now, cvss=None, epss=None, kind='vulnerability'))
    return result


def feed_entries(text):
    root = ET.fromstring(text)
    result = []
    for e in root.findall('./channel/item'):
        result.append({'title': e.findtext('title', ''), 'url': e.findtext('link', ''),
                       'date': e.findtext('pubDate', ''), 'body': e.findtext('description', ''), 'security': True})
    for e in root.findall('a:entry', ATOM):
        links = e.findall('a:link', ATOM)
        url = next((a.get('href') for a in links if a.get('rel', 'alternate') == 'alternate'), e.findtext('a:id', '', ATOM))
        result.append({'title': e.findtext('a:title', '', ATOM), 'url': url,
                       'date': e.findtext('a:updated', '', ATOM) or e.findtext('a:published', '', ATOM),
                       'body': e.findtext('a:content', '', ATOM) or e.findtext('a:summary', '', ATOM),
                       'security': any(t.text == 'security' for t in e.findall('p:tag', ATOM))})
    return result


def date_of(value):
    from email.utils import parsedate_to_datetime
    try: return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).date().isoformat()
    except ValueError:
        try: return parsedate_to_datetime(value).date().isoformat()
        except (ValueError, TypeError): return ''


def feed_records(key, text, now):
    label, base, layer, product = FEEDS[key]
    entries = feed_entries(text)
    if not entries: raise ValueError('Empty or unrecognized vendor feed')
    result = []
    for e in entries:
        title, body = plain(e['title']), plain(e['body'])
        if key == 'php' and not e['security']: continue
        if key == 'gitlab' and not re.search(r'security|vulnerabilit|CVE-', title + body, re.I): continue
        if key == 'ca' and not re.search(r'certificate.*(distrust|revok|revoc|misissu|compromis)|distrust.*certificate|compromis.*(ca |certificate)|root (program|store)', title, re.I): continue
        url = urllib.parse.urljoin(base, e['url']).replace('http://php.net/', 'https://www.php.net/')
        allowed = {'node': {'nodejs.org'}, 'php': {'www.php.net', 'php.net'}, 'gitlab': {'docs.gitlab.com', 'about.gitlab.com'}, 'ca': {'security.googleblog.com', 'blog.google'}}
        if not safe_url(url) or urllib.parse.urlsplit(url).hostname not in allowed[key]: continue
        day = date_of(e['date'])
        rid = key + '-' + hashlib.sha256(url.encode()).hexdigest()[:12]
        result.append(dict(id=rid, product=product, layer=layer, title=title, description=body[:700] or title,
                           impact='Trust / availability' if key == 'ca' else 'Security release',
                           action='Check the official advisory for affected configurations and install the appropriate supported security release.' if key != 'ca' else 'Inventory certificate issuers and chains; follow the browser root-program notice and replace affected certificates.',
                           affected=[], fixed=[], conditions=[], sources=[{'label': label, 'url': url}], source_id=key,
                           kev=False, kev_added='', ransomware=False, published=day, updated=day, checked_at=now,
                           cvss=None, epss=None, advisory_published_at=day, kind='incident' if key == 'ca' else 'release'))
        if len(result) >= (3 if key != 'php' else 4): break
    if key in ('node', 'php', 'gitlab') and not result: raise ValueError('Feed has no recognizable security entries')
    return result


def vendor_records(key, now):
    records = feed_records(key, fetch(FEEDS[key][1]), now)
    if key == 'ca': return records
    # Inspect the current vendor release for new CVEs, including flaws not yet in KEV.
    latest = records[0]
    text = plain(fetch(latest['sources'][0]['url']))
    discovered = []
    for rid in list(dict.fromkeys(re.findall(r'CVE-\d{4}-\d{4,8}', text)))[:16]:
        record = latest.copy()
        record.update(id=rid, kind='vulnerability', title=latest['product'] + ' · ' + rid,
                      description='New CVE referenced in the official security release. Check its affected versions and prerequisites.',
                      sources=latest['sources'] + [{'label': 'CVE record', 'url': 'https://www.cve.org/CVERecord?id=' + rid}])
        discovered.append(record)
    return records + discovered


def enrich(record, now):
    if not cve_id(record['id']): return record, None
    try:
        data = fetch('https://cveawg.mitre.org/api/cve/' + record['id'], True)
        if data.get('cveMetadata', {}).get('state') == 'REJECTED':
            record['rejected'] = True; return record, None
        cna = data.get('containers', {}).get('cna', {})
        if not cna.get('affected') and not cna.get('descriptions'): raise ValueError('Incomplete CVE record')
        record['published'] = data.get('cveMetadata', {}).get('datePublished', '')[:10]
        record['updated'] = data.get('cveMetadata', {}).get('dateUpdated', '')[:10]
        record['source_updated_at'] = data.get('cveMetadata', {}).get('dateUpdated', '')
        record['cve_checked_at'] = now
        record.pop('cve_status', None)
        if record.get('source_id') != 'kev':
            record['title'] = plain(cna.get('title')) or record['title']
            description = next((x.get('value') for x in cna.get('descriptions', []) if x.get('lang', '').startswith('en')), '')
            if description: record['description'] = plain(description)[:1800]
            record['impact'] = impact_for(record['title'] + ' ' + record['description'])
        record['affected'], record['fixed'], record['conditions'] = [], [], []
        for a in cna.get('affected', []):
            prefix = a.get('product', record['product'])
            has_affected = any(v.get('status') == 'affected' for v in a.get('versions', []))
            record['conditions'].extend(a.get('platforms', []) + a.get('modules', []))
            for v in a.get('versions', []):
                version = v.get('version', '?')
                if v.get('lessThan'): version += ' to < ' + str(v['lessThan'])
                elif v.get('lessThanOrEqual'): version += ' through ' + str(v['lessThanOrEqual'])
                if v.get('changes'): version += ' (status changes within range; see CNA record)'
                if v.get('status') == 'affected': record['affected'].append(prefix + ': ' + version)
                # Only explicit unaffected versions, never guess a fix from a range boundary.
                if v.get('status') == 'unaffected' and has_affected and re.match(r'^\d+\.\d+', version):
                    record['fixed'].append(prefix + ': ' + version + ' (CNA: unaffected)')
        record['conditions'].extend(plain(x.get('value')) for x in cna.get('configurations', []) if x.get('lang', 'en').startswith('en'))
        record['conditions'] = list(dict.fromkeys(str(x) for x in record['conditions'] if x))[:12]
        for m in cna.get('metrics', []):
            for key in ('cvssV4_0', 'cvssV3_1', 'cvssV3_0', 'cvssV2_0'):
                score = m.get(key, {})
                if 'baseScore' in score:
                    record['cvss'] = {'score': score['baseScore'], 'version': score.get('version', '?'), 'vector': score.get('vectorString', '')}; break
            if record['cvss']: break
        for ref in cna.get('references', []):
            url = ref.get('url', '')
            # CVE references are not all vendor advisories. Label provenance honestly.
            if safe_url(url) and not any(x in url.lower() for x in ('exploit', 'metasploit', 'poc')):
                record['sources'].append({'label': 'CNA reference · ' + urllib.parse.urlsplit(url).hostname, 'url': url})
                if len(record['sources']) >= 6: break
        return record, None
    except urllib.error.HTTPError as error:
        if error.code == 404:
            record['cve_status'] = 'awaiting public CNA record'
            return record, 'pending:' + record['id']
        return record, record['id'] + ': HTTP ' + str(error.code)
    except Exception as error:
        return record, record['id'] + ': ' + type(error).__name__


MATERIAL = ('title', 'description', 'action', 'affected', 'fixed', 'conditions', 'kev', 'ransomware', 'cvss', 'sources', 'rejected', 'source_changed', 'catalog_missing')


def revision(record):
    return hashlib.sha256(json.dumps({k: record.get(k) for k in MATERIAL}, sort_keys=True).encode()).hexdigest()[:16]


def priority(record):
    if record.get('rejected'): return 3
    score = (record.get('cvss') or {}).get('score', 0)
    high_impact = record.get('impact') in ('Code execution', 'Auth bypass', 'Credential / session theft')
    if record.get('kev') and (high_impact or record.get('ransomware')): return 0
    if record.get('kev') or score >= 9 or record.get('urgent'): return 1
    return 2


def material_update(record, prior):
    """Record source-dated technical changes only after an observed baseline exists."""
    if not prior: return ''
    previous = prior.get('material_updated_at', '')
    updated = record.get('source_updated_at') or record.get('updated', '')
    if not updated or updated <= (prior.get('source_updated_at') or prior.get('updated', '')): return previous
    technical = ('description', 'affected', 'fixed', 'conditions', 'cvss')
    return updated if any(record.get(k) != prior.get(k) for k in technical) else previous


def validate(data):
    if data.get('schema') != 1 or not isinstance(data.get('records'), list) or not data['records']: raise ValueError('Invalid snapshot')
    ids = set()
    for r in data['records']:
        if r['id'] in ids or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', r['id']): raise ValueError('Invalid or duplicate ID')
        ids.add(r['id'])
        if r['layer'] not in LAYERS or not r['action'] or not r['sources']: raise ValueError('Incomplete record')
        for s in r['sources']:
            if not safe_url(s['url']): raise ValueError('Unsafe source URL')
        if r.get('revision') != revision(r): raise ValueError('Revision mismatch')
        if r.get('priority') != priority(r): raise ValueError('Priority mismatch')
        score = r.get('cvss')
        if score and not 0 <= float(score['score']) <= 10: raise ValueError('Invalid CVSS')
        epss = r.get('epss')
        if epss and not 0 <= float(epss['score']) <= 1: raise ValueError('Invalid EPSS')
    return True


def run(output):
    now = stamp()
    previous = json.loads(output.read_text()) if output.exists() else {'records': [], 'sources': []}
    old = {r['id']: r for r in previous['records']}
    old_sources = {s['id']: s for s in previous['sources']}
    records, sources, errors = {}, [], []

    def source(key, label, url, task):
        state = dict(id=key, label=label, url=url, checked_at=now, last_success=old_sources.get(key, {}).get('last_success', ''), status='ok', error='')
        try:
            value = task(); state['last_success'] = now
        except Exception as error:
            state['status'], state['error'] = 'failed', type(error).__name__ + ': ' + str(error)[:180]
            errors.append(key); value = None
        sources.append(state)
        return value

    def read_kev():
        raw = fetch(KEV, True)
        return raw, kev_records(raw, now, old)
    kev_result = source('kev', 'CISA known exploited vulnerabilities', KEV, read_kev)
    kev = kev_result[1] if kev_result is not None else None
    if kev is not None:
        # Re-check retained KEVs too; absence is flagged rather than silently deleted.
        fresh = {r['id']: r for r in kev}
        for rid, prior in old.items():
            if prior.get('source_id') == 'kev' and rid not in fresh:
                catalog = prior.copy(); catalog.update(catalog_missing=True, kev=False, checked_at=now); fresh[rid] = catalog
        records.update(fresh)
    for key, (label, url, _, _) in FEEDS.items():
        found = source(key, label, url, lambda k=key: vendor_records(k, now))
        if found is not None:
            for r in found:
                if r['id'] not in records: records[r['id']] = r
    # Reviewed incident/action overrides have direct official source URLs.
    curated = json.loads((ROOT / 'curated.json').read_text())
    for entry in curated:
        rid = entry['id']
        current = records.get(rid) or old.get(rid)
        if current is None:
            current = dict(affected=[], fixed=[], conditions=[], kev=False, kev_added='', ransomware=False,
                           published='', updated='', checked_at='', cvss=None, epss=None, kind='vulnerability', source_id='curated')
        current = {**current, **entry}
        if entry.get('published'): current['advisory_published_at'] = entry['published']
        key = 'reviewed-' + rid.lower()
        state = source(key, entry['product'] + ' reviewed advisory', entry['sources'][0]['url'], lambda u=entry['sources'][0]['url']: fetch(u))
        prior = old_sources.get(key, {})
        if state is not None:
            digest = hashlib.sha256(plain(state).encode()).hexdigest()
            sources[-1]['fingerprint'] = digest
            # Source changes do not silently re-verify human-authored technical claims.
            current['source_changed'] = (bool(prior.get('fingerprint') and prior['fingerprint'] != digest) or bool(old.get(rid, {}).get('source_changed'))) and entry.get('accept_source_change') != digest
            current['checked_at'] = now
        else:
            sources[-1]['fingerprint'] = prior.get('fingerprint', '')
        records[rid] = current
    # Carry existing data through source outages and keep historical advisories searchable.
    for rid, r in old.items(): records.setdefault(rid, r.copy())
    # The reviewed incident replaces its generic feed item at the same official URL.
    incident_urls = {s['url']: e['id'] for e in curated if e.get('kind') == 'incident' for s in e['sources']}
    for rid, r in list(records.items()):
        if r.get('kind') == 'incident' and any(s['url'] in incident_urls and incident_urls[s['url']] != rid for s in r['sources']):
            del records[rid]
    # Check vendor discoveries against the entire catalog, not just the selected recent KEVs.
    if kev_result is not None:
        catalog = {r['cveID']: r for r in kev_result[0]['vulnerabilities']}
        for rid, r in records.items():
            if rid in catalog:
                fact = catalog[rid]
                r.update(kev=True, kev_added=fact['dateAdded'], ransomware=fact.get('knownRansomwareCampaignUse') == 'Known')
                if not any(s['label'] == 'CISA KEV' for s in r['sources']):
                    r['sources'].append({'label': 'CISA KEV', 'url': 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=' + rid})

    cves = [r for r in records.values() if cve_id(r['id']) and r.get('checked_at') == now]
    cve_errors, cve_pending = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for record, error in pool.map(lambda r: enrich(r, now), cves):
            if error and error.startswith('pending:'):
                cve_pending.append(record['id'])
            elif error:
                prior = old.get(record['id'], {})
                for key in ('affected', 'fixed', 'conditions', 'cvss', 'published', 'updated', 'source_updated_at', 'cve_checked_at'):
                    if key in prior: record[key] = prior[key]
                cve_errors.append(error)
            records[record['id']] = record
    # Restore reviewed action/version text after CVE enrichment; never overwrite KEV evidence.
    for entry in curated:
        for field in ('action', 'affected', 'fixed', 'conditions', 'steps', 'urgent', 'impact', 'description', 'title'):
            if field in entry: records[entry['id']][field] = entry[field]
    sources.append(dict(id='cve', label='CVE Program / CNA records', url='https://www.cve.org/', checked_at=now,
                        last_success=now if not cve_errors else old_sources.get('cve', {}).get('last_success', ''),
                        status='failed' if cve_errors else 'ok', error='; '.join(cve_errors)[:800],
                        note=(str(len(cve_pending)) + ' vendor-confirmed CVEs awaiting public CNA records') if cve_pending else ''))
    if cve_errors: errors.append('cve')
    ids = [r['id'] for r in records.values() if cve_id(r['id'])]
    def epss_data():
        result = fetch('https://api.first.org/data/v1/epss?' + urllib.parse.urlencode({'cve': ','.join(ids), 'limit': 1000}), True)
        if result.get('status') != 'OK' or not isinstance(result.get('data'), list): raise ValueError('Invalid EPSS response')
        return result['data']
    epss = source('epss', 'FIRST EPSS (30-day probability)', 'https://www.first.org/epss/', epss_data)
    if epss is not None:
        for r in records.values():
            if cve_id(r['id']): r['epss'] = None
        for e in epss:
            if e['cve'] in records:
                records[e['cve']]['epss'] = dict(score=float(e['epss']), percentile=float(e['percentile']), date=e['date'])
    else:
        for rid, r in records.items(): r['epss'] = old.get(rid, {}).get('epss')
    changes = []
    for rid, r in records.items():
        r['revision'] = revision(r); r['priority'] = priority(r)
        prior = old.get(rid)
        r['material_updated_at'] = material_update(r, prior)
        if not prior or prior.get('revision') != r['revision']:
            r['changed_at'] = now; r['change'] = 'updated' if prior else 'new'
            changes.append({'id': rid, 'type': r['change'], 'at': now})
        else:
            r['changed_at'] = prior.get('changed_at', now); r['change'] = prior.get('change', '')
    data = dict(schema=1, last_attempt=now, last_success=now if not errors else previous.get('last_success', ''),
                refresh_status='partial' if errors else 'ok', sources=sources,
                records=sorted(records.values(), key=lambda r: (r['priority'], -(int((r.get('published') or r.get('kev_added') or '2000-01-01').replace('-', ''))), r['id'])),
                changes=(changes + previous.get('changes', []))[:500])
    validate(data)
    temp = output.with_suffix('.tmp'); temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n'); os.replace(temp, output)
    print(f"{len(records)} records; {len(changes)} changes; refresh {data['refresh_status']}; failed sources: {', '.join(errors) or 'none'}")
    return bool(errors)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate the committed snapshot without network access')
    parser.add_argument('--output', type=Path, default=ROOT / 'data.json')
    args = parser.parse_args()
    if args.check:
        validate(json.loads(args.output.read_text())); print('PASS: snapshot schema, priorities, revisions and source URLs')
    else:
        raise SystemExit(2 if run(args.output) else 0)
