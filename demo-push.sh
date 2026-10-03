#!/bin/bash
# Regenerate manifest.json from demo/ directory, then push to GitHub Pages.
# Usage: demo-push "commit message"
set -e
cd ~/git/demo

python3 - <<'PYEOF'
import os, json, datetime

META = {
  'lakebase-objection-faq/':('Lakebase Objections FAQ','Nine technical objections answered honestly · incl. Aurora head-to-head','Work','#f7b731'),
  'aidecide-arena/':('AI Arena — ai_decide vs Jev','Snake + Tic-Tac-Toe deathmatch, live model I/O inspection','AI','#FF3621'),
  'tongjian/':         ('資治通鑑 · 294卷全文','司馬光 · 周威烈王至後周世宗 · 前403–959','📖 讀史','#8b2f1f'),
  'llm-pricing/':      ('LLM Token Pricing 對比','Databricks FMAPI vs Bedrock / Azure / Fireworks / GCP / AliCloud · 原廠價 · regions','🔥 Hot','#ff6b35'),
  'lakehouse-quest.html':('Lakehouse Quest','互動 Lakehouse 冒險','Interactive','#4ecdc4'),
  'neon-orbit.html':   ('Neon Orbit','Neon orbit demo','Interactive','#4ecdc4'),
  'lakebase-sales-play/':('Lakebase Sales Play','銷售 playbook','Work','#f7b731'),
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
