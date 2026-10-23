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
        with self.assertRaises(ValueError): R.feed_records('php', xml, 'today')
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

    def test_rejected_or_unsafe_snapshot_cannot_validate(self):
        data = json.loads((R.ROOT / 'data.json').read_text())
        self.assertTrue(R.validate(data))
        bad = copy.deepcopy(data); bad['records'][0]['sources'][0]['url'] = 'javascript:alert(1)'
        with self.assertRaises(ValueError): R.validate(bad)


if __name__ == '__main__': unittest.main()
