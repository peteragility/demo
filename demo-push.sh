#!/bin/bash
# Regenerate manifest.json from demo/ directory, then push to GitHub Pages.
# Usage: demo-push "commit message"
set -e
cd ~/git/demo

python3 - <<'PYEOF'
import os, json, datetime

META = {
  'sandbox-compare/':('Agent Sandbox Comparison','VMs, containers and isolation boundaries: vendors and open source side by side','Work','#58a6ff'),
  'lakebase-compete-calculator/':('Lakebase Calculator','Estimate Lakebase monthly costs against Aurora, RDS, Azure, Cloud SQL and ClickHouse','Featured','#3fb950'),
  'lakebase-objection-faq/':('Lakebase Field Guide','Architecture, objections, tradeoffs and production proof, with linked pricing scenarios','Work','#f7b731'),
  'aidecide-arena/':('AI Arena','Two decision models face off in Snake and Tic-Tac-Toe. Inspect every model move','AI','#FF3621'),
  'llm-pricing/':      ('LLM Token Pricing','Compare model APIs, cache rates, tiers and regions across providers and cloud platforms','Featured','#ff6b35'),
  'lakehouse-quest.html':('Lakehouse Quest','Databricks exam practice as a quest: questions, traps and revision notes','Interactive','#4ecdc4'),
  'neon-orbit.html':   ('Neon Orbit','A one-button gravity game. Jump between orbits and climb as high as you can','Interactive','#4ecdc4'),
}

CATEGORIES = {
  'aidecide-arena/': 'Interactive', 'lakebase-compete-calculator/': 'Tools',
  'lakebase-objection-faq/': 'Guides', 'lakehouse-quest.html': 'Interactive',
  'llm-pricing/': 'Tools', 'neon-orbit.html': 'Interactive', 'sandbox-compare/': 'Guides',
}
FEATURED = {'lakebase-compete-calculator/', 'lakebase-objection-faq/', 'llm-pricing/'}

pages = []
for name in sorted(os.listdir('.')):
    if name.startswith(('.', '_')) or name in ('logs',) or name.endswith(('.mp3', '.sh')):
        continue
    path = name + ('/' if os.path.isdir(name) else '')
    if path in ('index.html', 'penang-trip/', 'tongjian/'):
        continue
    ok = (os.path.isfile(name) and name.endswith('.html')) or (os.path.isdir(name) and os.path.exists(os.path.join(name, 'index.html')))
    if not ok:
        continue
    if path in META:
        t, d, tag, c = META[path]
        pages.append({'path': path, 'title': t, 'desc': d, 'tag': tag, 'color': c})
    else:
        # new page not in META: auto-list with generic meta (still shows up!)
        pages.append({'path': path, 'title': path, 'desc': '', 'tag': 'New', 'color': '#3fb950'})

for page in pages:
    page['category'] = CATEGORIES.get(page['path'], 'Other')
    page['featured'] = page['path'] in FEATURED

manifest = {'generated': datetime.date.today().isoformat(), 'pages': pages}
with open('manifest.json', 'w') as output:
    json.dump(manifest, output, ensure_ascii=False, indent=1)
    output.write('\n')
print(f'manifest.json: {len(pages)} pages')
PYEOF

git add -A
git diff --cached --quiet && echo "nothing to push" && exit 0
git commit -m "${1:-demo update $(date +%F\ %H:%M)}" --quiet
git push --quiet
echo "pushed ✅ → https://peteragility.github.io/demo/"
