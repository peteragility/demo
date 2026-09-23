#!/bin/bash
# Regenerate manifest.json from demo/ directory, then push to GitHub Pages.
# Usage: demo-push "commit message"
set -e
cd ~/git/demo

python3 - <<'PYEOF'
import os, json, datetime

META = {
  'llm-pricing/':      ('LLM Token Pricing 對比','Databricks FMAPI vs Bedrock / Azure / Fireworks / GCP / AliCloud · 原廠價 · regions','🔥 Hot','#ff6b35'),
  'ltap-blog.html':    ('The End of the 40-Year Database Divide','Why LTAP Changes Everything · 8 min read','Latest Post','#ff6b35'),
  'atom-deep-dive.html':('Atom Deep Dive — 原子結構深潛','Atom → Nucleus → Quark → Gluon → String · 互動 3D','Interactive','#c792ea'),
  'lakehouse-quest.html':('Lakehouse Quest','互動 Lakehouse 冒險','Interactive','#4ecdc4'),
  'quantum.html':      ('Quantum 互動頁','量子運算入門','Interactive','#4ecdc4'),
  'neon-orbit.html':   ('Neon Orbit','Neon orbit demo','Interactive','#4ecdc4'),
  'string-theory-trial/':('String Theory Trial','弦理論試驗場','Interactive','#4ecdc4'),
  'oss-models-comparison.html':('OSS Models Comparison','開源模型比較表','Reference','#58a6ff'),
  'aurora-vs-lakebase.html':('Aurora vs Lakebase','兩代 DB 之爭','Reference','#58a6ff'),
  'arsenal-transfers.html':('Arsenal Transfers','兵工廠轉會分析 ⚽','Football','#ef0107'),
  'arsenal-champions/':('Arsenal Champions','冠軍之路 ⚽','Football','#ef0107'),
  'lakebase-sales-play/':('Lakebase Sales Play','銷售 playbook','Work','#f7b731'),
  'lakebase-vs-aurora/':('Lakebase vs Aurora','深入對比','Work','#f7b731'),
  'penang-trip/':      ('Penang Trip','檳城之旅 🌴','Travel','#2ecc71'),
}

pages = []
for name in sorted(os.listdir('.')):
    if name.startswith(('.', '_')) or name in ('logs',) or name.endswith(('.mp3', '.sh')):
        continue
    path = name + ('/' if os.path.isdir(name) else '')
    if path == 'index.html':
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

manifest = {'generated': datetime.date.today().isoformat(), 'pages': pages}
json.dump(manifest, open('manifest.json', 'w'), ensure_ascii=False, indent=1)
print(f'manifest.json: {len(pages)} pages')
PYEOF

git add -A
git diff --cached --quiet && echo "nothing to push" && exit 0
git commit -m "${1:-demo update $(date +%F\ %H:%M)}" --quiet
git push --quiet
echo "pushed ✅ → https://peteragility.github.io/demo/"
