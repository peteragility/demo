import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withBrowser} from './browser-kit.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cards=JSON.parse(readFileSync(path.join(root,'preview-cards.json'),'utf8'));
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
mkdirSync(path.join(root,'assets'),{recursive:true});
await withBrowser(root,async b=>{
 for(const card of cards){
  if(!/^[a-z0-9_-]+$/.test(card.name)) throw new Error('Invalid preview file name');
  for(const field of ['background','ink','accent']) if(!/^#[0-9a-f]{6}$/i.test(card[field])) throw new Error('Invalid preview colour');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="${card.background}"/><path d="M50 72H1150M50 550H1150" stroke="${card.ink}" opacity=".3"/><text x="65" y="125" fill="${card.ink}" font-family="Arial,sans-serif" font-size="23" letter-spacing="3">${escape(card.brand)}</text><rect x="65" y="175" width="1070" height="250" rx="22" fill="${card.accent}" opacity=".18"/><text x="90" y="273" fill="${card.ink}" font-family="Arial,sans-serif" font-weight="700" font-size="64">${escape(card.title)}</text><text x="93" y="346" fill="${card.ink}" font-family="Arial,sans-serif" font-size="29">${escape(card.subtitle)}</text><circle cx="1080" cy="472" r="35" fill="${card.accent}"/><path d="m1063 472h32m-13-13 13 13-13 13" fill="none" stroke="${card.ink}" stroke-width="5" stroke-linecap="round"/><text x="65" y="485" fill="${card.ink}" font-family="Arial,sans-serif" font-size="22">${escape(card.footer)}</text></svg>`;
  const file=path.join(root,'assets',card.name+'.svg');writeFileSync(file,svg);
  await b.navigate('/assets/'+card.name+'.svg');await b.screenshot(path.join(root,'assets',card.name+'.png'));
 }
});
console.log('Rendered',cards.length,'sharing preview images.');
