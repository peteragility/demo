import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import refresh as R


class RefreshTests(unittest.TestCase):
    def test_hong_kong_event_dates_preserve_date_only_sources(self):
        for value in ['2026-09-23T18:00:00Z', '2026-09-23T18:00:00', 'Wed, 23 Sep 2026 18:00:00 GMT']:
            self.assertEqual(R.date_of(value), '2026-09-24')
            self.assertEqual(R.risk_event({'published': value}, '2026-10-23')[0], '2026-09-24')
        self.assertEqual(R.date_of('2026-09-23'), '2026-09-23')
        for value in ['', None, '2026-02-30', 'bad']:
            self.assertEqual(R.date_of(value), '')

    def test_cna_ranges_are_not_invented_fixes(self):
        record = dict(id='CVE-2026-1234', product='Test', source_id='kev', sources=[], cvss=None)
        value = {'cveMetadata': {}, 'containers': {'cna': {'affected': [{'product': 'Test', 'versions': [
            {'version': '1.0', 'lessThan': '1.9', 'status': 'affected'},
            {'version': '2.0', 'status': 'unaffected'}]}]}}}
        with patch.object(R, 'fetch', return_value=value):
            result, error = R.enrich(record, '2026-10-23T00:00:00Z')
        self.assertIsNone(error)
        self.assertEqual(result['affected'], ['Test: 1.0 to < 1.9'])
        self.assertEqual(result['fixed'], ['Test: 2.0 (CNA: unaffected)'])

    def test_pending_cna_is_unknown_not_fabricated_severity(self):
        record = dict(id='CVE-2026-1234', source_id='node', cvss=None)
        with patch.object(R, 'fetch', side_effect=urllib.error.HTTPError('https://example.test', 404, 'missing', {}, None)):
            result, error = R.enrich(record, 'today')
        self.assertTrue(error.startswith('pending:'))
        self.assertIsNone(result['cvss'])

    def test_one_vendor_page_failure_keeps_other_new_cves(self):
        feed = '''<rss><channel><item><title>Security release</title><link>https://nodejs.org/good</link><pubDate>Wed, 21 Oct 2026 00:00:00 GMT</pubDate></item><item><title>Older security release</title><link>https://nodejs.org/bad</link><pubDate>Tue, 20 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>'''
        def read(url):
            if url == R.FEEDS['node'][1]: return feed
            if url.endswith('/bad'): raise OSError('temporary outage')
            return '<p>CVE-2026-12345</p>'
        failures = []
        with patch.object(R, 'fetch', side_effect=read):
            records = R.vendor_records('node', '2026-10-23T00:00:00Z', failures)
        self.assertIn('CVE-2026-12345', [r['id'] for r in records])
        self.assertEqual(len(failures), 1)
        self.assertIn('/bad', failures[0])

    def test_repeated_enrichment_replaces_cna_references(self):
        record = dict(id='CVE-2026-1234', product='Test', source_id='kev', sources=[
            {'label': 'Vendor', 'url': 'https://vendor.test/advisory'},
            {'label': 'CNA reference · old.test', 'url': 'https://old.test/stale'}])
        cna = {'descriptions': [{'lang': 'en', 'value': 'Example'}], 'references': [
            {'url': 'https://vendor.test/advisory'}, {'url': 'https://new.test/current'},
            {'url': 'https://new.test/current'}]}
        with patch.object(R, 'fetch', return_value={'containers': {'cna': cna}}):
            first, error = R.enrich(record, '2026-10-23T00:00:00Z')
            self.assertIsNone(error)
            first_sources = copy.deepcopy(first['sources'])
            second, error = R.enrich(first, '2026-10-24T00:00:00Z')
        self.assertIsNone(error)
        self.assertEqual(second['sources'], first_sources)
        self.assertEqual([s['url'] for s in second['sources']], ['https://vendor.test/advisory', 'https://new.test/current'])

    def test_pending_cna_preserves_prior_score_and_removed_kev_clears_vendor_label(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            output = Path(tmp) / 'data.json'
            with patch.object(R, 'fetch', side_effect=self.fixture), patch.object(R, 'stamp', return_value='2026-10-23T01:00:00Z'):
                R.run(output)
            first = json.loads(output.read_text())
            prior = next(r for r in first['records'] if r['id'] == 'CVE-2026-10000')
            prior.update(cvss={'score': 9.8, 'version': '3.1'}, fixed=['Confirmed fixed build'], cve_checked_at='2026-10-22T01:00:00Z')
            prior['revision'] = R.revision(prior)
            vendor = next(r for r in first['records'] if r['id'] == 'CVE-2026-109618')
            vendor.update(kev=True, kev_added='2026-10-22', ransomware=True)
            output.write_text(json.dumps(first))
            def read(url, as_json=False):
                if url.endswith('/CVE-2026-10000'):
                    raise urllib.error.HTTPError(url, 404, 'temporarily missing', {}, None)
                return self.fixture(url, as_json)
            with patch.object(R, 'fetch', side_effect=read), patch.object(R, 'stamp', return_value='2026-10-24T01:00:00Z'):
                R.run(output)
            second = json.loads(output.read_text())
            record = next(r for r in second['records'] if r['id'] == prior['id'])
            for key in ('cvss', 'fixed', 'cve_checked_at'): self.assertEqual(record[key], prior[key])
            self.assertEqual(record['cve_status'], 'awaiting public CNA record')
            vendor = next(r for r in second['records'] if r['id'] == vendor['id'])
            self.assertFalse(vendor['kev'])
            self.assertFalse(vendor['ransomware'])
            self.assertTrue(vendor['catalog_missing'])

    def test_material_revisions_ignore_daily_check_and_epss(self):
        r = {'title': 'A', 'action': 'Patch', 'affected': ['1.x'], 'checked_at': 'old', 'epss': {'score': 0.1}}
        new = {**r, 'checked_at': 'new', 'epss': {'score': 0.9}}
        self.assertEqual(R.revision(r), R.revision(new))
        self.assertNotEqual(R.revision(r), R.revision({**new, 'fixed': ['1.2']}))
        self.assertNotEqual(R.revision(r), R.revision({**new, 'source_changed': True}))

    def test_recent_technical_updates_require_both_a_source_date_and_observed_changes(self):
        old = {'updated': '2026-10-21', 'source_updated_at': '2026-10-21T10:00:00Z', 'fixed': ['1.2'], 'material_updated_at': ''}
        self.assertEqual(R.material_update({**old, 'fixed': ['1.3']}, None), '')
        self.assertEqual(R.material_update({**old, 'checked_at': '2026-10-23'}, old), '')
        self.assertEqual(R.material_update({**old, 'source_updated_at': '2026-10-21T11:00:00Z'}, old), '')
        self.assertEqual(R.material_update({**old, 'fixed': ['1.3']}, old), '')
        new = {**old, 'source_updated_at': '2026-10-21T11:00:00Z', 'fixed': ['1.3']}
        self.assertEqual(R.material_update(new, old), new['source_updated_at'])
        self.assertEqual(R.material_update({**new, 'material_updated_at': new['source_updated_at']}, {**new, 'material_updated_at': new['source_updated_at']}), new['source_updated_at'])

    def test_unsafe_feed_links_and_nonsecurity_php_are_excluded(self):
        xml = '''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:p="http://php.net/ns/releases"><entry><title>PHP release</title><id>javascript:alert(1)</id><p:tag>security</p:tag></entry></feed>'''
        self.assertEqual(R.feed_records('php', xml, '2026-10-23T00:00:00Z'), [])
        self.assertFalse(R.safe_url('https://user:pass@example.test'))
        self.assertEqual(R.plain('<script>alert(1)</script><p>Safe</p>'), 'Safe')

    def fixture(self, url, as_json=False):
        if url == R.KEV:
            return {'vulnerabilities': [dict(cveID=f'CVE-2026-{10000+i}', vendorProject='Example', product='Server',
                vulnerabilityName='Remote Code Execution', shortDescription='Code execution', requiredAction='Apply vendor patch',
                dateAdded='2026-10-20', knownRansomwareCampaignUse='Unknown') for i in range(100)]}
        if 'api.first.org/' in url: return {'status': 'OK', 'data': []}
        if 'cveawg.mitre.org/' in url:
            return {'cveMetadata': {'datePublished': '2026-10-21'}, 'containers': {'cna': {'title': 'Example flaw', 'descriptions': [{'lang':'en','value':'Example code execution'}], 'affected': [], 'references': []}}}
        if url in [v[1] for v in R.FEEDS.values()]:
            if 'php.net' in url:
                return '''<feed xmlns="http://www.w3.org/2005/Atom" xmlns:p="http://php.net/ns/releases"><entry><title>PHP security release</title><id>https://www.php.net/releases/8_5_12.php</id><updated>2026-10-21T00:00:00Z</updated><p:tag>security</p:tag></entry></feed>'''
            host = 'docs.gitlab.com' if 'gitlab' in url else 'nodejs.org' if 'nodejs' in url else 'blog.google'
            return '<rss><channel><item><title>Security release</title><link>https://' + host + '/security/</link><pubDate>Wed, 21 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>'
        return '<main><h1>Official advisory</h1><p>Reviewed instructions.</p></main>'

    def test_repeat_run_and_source_outage_preserve_data_and_last_success(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            output = Path(tmp) / 'data.json'
            with patch.object(R, 'fetch', side_effect=self.fixture), patch.object(R, 'stamp', return_value='2026-10-23T01:00:00Z'):
                self.assertFalse(R.run(output))
            first = json.loads(output.read_text()); self.assertEqual(first['refresh_status'], 'ok')
            with patch.object(R, 'fetch', side_effect=self.fixture), patch.object(R, 'stamp', return_value='2026-10-24T01:00:00Z'):
                self.assertFalse(R.run(output))
            second = json.loads(output.read_text())
            for rid in ('CVE-2026-109618', 'CVE-2026-109619', 'emudhra-ca-2026-10'):
                a = next(r for r in first['records'] if r['id'] == rid)
                b = next(r for r in second['records'] if r['id'] == rid)
                self.assertEqual(a['ranking_evidence'], b['ranking_evidence'])
                self.assertNotIn('impact_scope', b)
                self.assertTrue(b['ranking_evidence']['url'])
            self.assertEqual({r['id']: r['revision'] for r in first['records']}, {r['id']: r['revision'] for r in second['records']})
            self.assertEqual(second['changes'], first['changes'])
            with patch.object(R, 'fetch', side_effect=OSError('outage')), patch.object(R, 'stamp', return_value='2026-10-25T01:00:00Z'):
                self.assertTrue(R.run(output))
            failed = json.loads(output.read_text())
            self.assertEqual(failed['last_success'], second['last_success'])
            self.assertEqual(len(failed['records']), len(second['records']))
            prior = {r['id']: r for r in second['records']}
            for r in failed['records']: self.assertEqual(r['checked_at'], prior[r['id']]['checked_at'])
            self.assertTrue(all(s['status'] == 'failed' for s in failed['sources'] if s['id'] != 'cve'))

    def test_retention_high_risk_and_date_boundaries(self):
        now = '2026-10-23T06:00:00Z'
        self.assertEqual(R.window_dates(now), ('2026-09-24', '2026-04-23', '2026-10-23'))
        self.assertEqual(R.window_dates('2026-08-31T06:00:00Z')[1], '2026-02-28')
        records = [dict(id=str(i), published=day, cvss={'score': 7}) for i, day in enumerate(['2026-10-23','2026-09-24','2026-09-23','2026-04-23','2026-04-22','2026-10-24'])]
        kept, scope = R.retain(records, now)
        self.assertEqual([r['id'] for r in kept], ['0','1','2','3'])
        self.assertEqual((scope['current_count'],scope['archive_count']), (2,2))
        self.assertFalse(R.high_risk({'cvss': {'score': 6.9}}))
        self.assertTrue(R.high_risk({'kev': True}))
        self.assertTrue(R.high_risk({'urgent': True}))
        self.assertFalse(R.high_risk({'kev': True, 'rejected': True}))
        old = dict(published='2020-01-01', checked_at=now, changed_at=now, cvss={'score': 9})
        self.assertEqual(R.retain([old], now)[0], [])
        self.assertEqual(R.retain([{**old, 'kev': True, 'kev_added': '2026-10-20'}], now)[1]['current_count'], 1)

    def test_systemic_signal_matches_shared_browser_fixtures_without_manual_flags(self):
        for sample in json.loads((R.ROOT / 'ranking-fixtures.json').read_text()):
            record = dict(published='2026-10-21', ranking_evidence=dict(text=sample['text'], url='https://vendor.test/advisory'))
            self.assertEqual(R.systemic_signal(record), sample['signal'], sample['text'])
            self.assertEqual(R.high_risk(record), bool(sample['signal']))
            self.assertEqual(len(R.retain([record], '2026-10-23T06:00:00Z')[0]), int(bool(sample['signal'])))

    def test_attention_feeds_count_independent_reports_in_window_only(self):
        rss = '''<rss><channel>
          <item><title>CVE-2026-1234 exploited widely</title><link>https://therecord.media/a</link><pubDate>Thu, 22 Oct 2026 00:00:00 GMT</pubDate><description>Original reporting on CVE-2026-1234.</description></item>
          <item><title>Older coverage</title><link>https://therecord.media/b</link><pubDate>Wed, 01 Oct 2026 00:00:00 GMT</pubDate><description>CVE-2026-1234 mention</description></item>
          <item><title>Unsafe link</title><link>javascript:alert(1)</link><pubDate>Thu, 22 Oct 2026 00:00:00 GMT</pubDate><description>CVE-2026-1234</description></item>
        </channel></rss>'''
        reports = R.attention_from_feed('news', rss, '2026-10-02')
        self.assertEqual(reports, {'CVE-2026-1234': [{'k': 'news', 'url': 'https://therecord.media/a', 'at': '2026-10-22'}]})
        with self.assertRaises(ValueError): R.attention_from_feed('news', '<html><body>not a feed</body></html>', '2026-10-02')

    def test_hacker_news_attention_requires_exact_cve_in_story_and_recent_date(self):
        payload = {'hits': [
            {'objectID': '1', 'title': 'Big VPN flaw discussion', 'url': 'https://vendor.test/x', 'created_at': '2026-10-22T00:00:00Z'},
            {'objectID': '2', 'title': 'Something else CVE-2026-5678', 'url': '', 'created_at': '2026-10-22T00:00:00Z'},
            {'objectID': '3', 'title': 'CVE-2026-5678 retro coverage', 'url': '', 'created_at': '2026-04-22T00:00:00Z'}]}
        with patch.object(R, 'fetch', return_value=payload):
            reports = R.hn_attention(['CVE-2026-5678'], '2026-10-02')
        self.assertEqual(reports, {'CVE-2026-5678': [{'k': 'hn', 'url': 'https://news.ycombinator.com/item?id=2', 'at': '2026-10-22'}]})

    def test_github_exploit_search_maps_repositories_to_cves(self):
        pages = [{'items': [{'name': 'CVE-2026-5678-poc', 'description': 'Working exploit', 'html_url': 'https://github.com/a/CVE-2026-5678-poc'},
                            {'name': 'unrelated', 'description': 'No cve here', 'html_url': 'https://github.com/a/other'}]},
                 {'items': []}]
        with patch.object(R, 'fetch', side_effect=pages):
            reports = R.github_exploits('2026-04-30')
        self.assertEqual(reports, {'CVE-2026-5678': ['https://github.com/a/CVE-2026-5678-poc']})

    def test_snapshot_validation_rejects_unsafe_attention_and_exploit_evidence(self):
        data = json.loads((R.ROOT / 'data.json').read_text())
        record = copy.deepcopy(data['records'][0])
        for heat in [{'reports': [{'k': 'news', 'url': 'javascript:alert(1)', 'at': '2026-10-22'}]},
                     {'reports': [{'k': 'forum', 'url': 'https://forum.test/t', 'at': '2026-10-22'}]},
                     {'reports': []}, {'reports': None}]:
            bad = copy.deepcopy(data); bad['records'][0] = {**record, 'heat': heat}
            with self.assertRaises(ValueError): R.validate(bad)
        for exploit in [{'refs': ['http://github.com/a/poc']}, {'refs': []}]:
            bad = copy.deepcopy(data); bad['records'][0] = {**record, 'exploit': exploit}
            with self.assertRaises(ValueError): R.validate(bad)

    def test_attention_outage_retains_previous_heat_and_exploit(self):
        now = '2026-10-23T01:00:00Z'
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            output = Path(tmp) / 'data.json'
            with patch.object(R, 'fetch', side_effect=self.fixture), patch.object(R, 'stamp', return_value=now):
                R.run(output)
            first = json.loads(output.read_text())
            prior_heat = {'reports': [{'k': 'news', 'url': 'https://therecord.media/a', 'at': '2026-10-22'}], 'as_of': now}
            prior_exploit = {'refs': ['https://github.com/a/CVE-2026-10000'], 'at': now}
            for r in first['records']:
                if r['id'] == 'CVE-2026-10000':
                    r['heat'] = prior_heat; r['exploit'] = prior_exploit
            output.write_text(json.dumps(first))
            def read(url, as_json=False):
                if any(host in url for host in ('bleepingcomputer.com', 'therecord.media', 'reddit.com', 'hn.algolia.com', 'api.github.com')):
                    raise OSError('attention outage')
                return self.fixture(url, as_json)
            history = {'at': now, 'current': {'CVE-2026-10000': 1}, 'previous': {}}
            first['rank_history'] = history; output.write_text(json.dumps(first))
            with patch.object(R, 'fetch', side_effect=read), patch.object(R, 'stamp', return_value='2026-10-24T01:00:00Z'):
                R.run(output)
            second = json.loads(output.read_text())
            record = next(r for r in second['records'] if r['id'] == 'CVE-2026-10000')
            self.assertEqual(record['heat'], prior_heat)
            self.assertEqual(record['exploit'], prior_exploit)
            self.assertEqual(second['refresh_status'], 'ok')
            self.assertTrue(all(s['status'] == 'failed' for s in second['sources'] if s['id'] in ('press', 'reddit', 'hn', 'poc')))
            # The snapshot rewrite keeps rank_history so ranks.cjs can move current -> previous.
            self.assertEqual(second['rank_history'], history)

    def test_categories_bucket_by_what_the_reader_patches(self):
        self.assertEqual(R.layer_for('MikroTik RouterOS'), 'edge')
        self.assertEqual(R.layer_for('Arista VeloCloud Orchestrator'), 'edge')
        self.assertEqual(R.layer_for('JFrog Artifactory'), 'delivery')
        self.assertEqual(R.layer_for('Google Chromium V8'), 'runtime')
        self.assertEqual(R.layer_for('Microsoft SharePoint'), 'app')
        self.assertEqual(R.layer_for('WordPress Core'), 'app')
        self.assertEqual(R.layer_for('Linux Kernel'), 'system')
        # The retired catch-all layer remaps instead of stranding archived history.
        self.assertEqual(R.LAYER_MIGRATION, {'identity': 'app'})

    def test_rejected_or_unsafe_snapshot_cannot_validate(self):
        data = json.loads((R.ROOT / 'data.json').read_text())
        self.assertTrue(R.validate(data))
        bad = copy.deepcopy(data); bad['records'][0]['sources'][0]['url'] = 'javascript:alert(1)'
        with self.assertRaises(ValueError): R.validate(bad)
        bad = copy.deepcopy(data)
        record = next(r for r in bad['records'] if r.get('ranking_evidence'))
        record['ranking_evidence']['url'] = 'javascript:alert(1)'
        with self.assertRaises(ValueError): R.validate(bad)



if __name__ == '__main__': unittest.main()
