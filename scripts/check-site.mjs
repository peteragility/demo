import assert from 'node:assert/strict';
import {readdirSync,readFileSync,writeFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=process.argv[2] ? path.resolve(repo,process.argv[2]) : repo;
const temp=mkdtempSync(path.join(os.tmpdir(),'site-check-'));
const files=[];
function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.name==='data'||entry.name==='logs'||(entry.name==='dist'&&root===repo))continue;const p=path.join(directory,entry.name);if(entry.isDirectory())visit(p);else if(entry.name.endsWith('.html'))files.push(p);}}
try{
 visit(root);let scripts=0,links=0;
 const cardConfig=path.join(repo,'preview-cards.json');
 if(existsSync(cardConfig))for(const card of JSON.parse(readFileSync(cardConfig,'utf8'))){
  const png=readFileSync(path.join(root,'assets',card.name+'.png'));
  assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),1200);assert.equal(png.readUInt32BE(20),630);
 }
 for(const file of files){
  const text=readFileSync(file,'utf8');const document=text.replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<style\b[\s\S]*?<\/style>/gi,'');
  if(!/<meta[^>]*http-equiv="refresh"/i.test(document)){
   assert.match(document,/<meta\s+[^>]*name="description"/i,file+' needs a description');
   assert.match(document,/<meta\s+[^>]*property="og:image"/i,file+' needs a sharing image');
  }
  for(const match of document.matchAll(/\b(?:href|src)="([^"]*)"/g)){
   const href=match[1].replaceAll('&amp;','&');if(!href||/^(?:https?:|data:|mailto:|tel:)/i.test(href))continue;
   const url=new URL(href,'https://local.test/'+path.relative(root,file).split(path.sep).join('/'));
   if(url.hostname!=='local.test')continue;
   let target=path.join(root,decodeURIComponent(url.pathname));if(url.pathname.endsWith('/'))target=path.join(target,'index.html');
   assert.ok(existsSync(target),file+' links to missing '+href);links++;
   if(url.hash&&root.endsWith('dist')&&/\.html$/.test(target)){
    const id=decodeURIComponent(url.hash.slice(1));assert.ok(readFileSync(target,'utf8').includes('id="'+id+'"'),file+' has missing anchor '+href);
   }
  }
  for(const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
   if(/\bsrc=|type="(?:application\/json|importmap)"/i.test(match[1]))continue;
   const name=path.join(temp,'inline-'+scripts+++'.js');writeFileSync(name,match[2]);execFileSync(process.execPath,['--check',name],{input:undefined,stdio:'pipe'});
  }
 }
 console.log(`PASS: ${files.length} pages, ${links} local links, ${scripts} inline scripts and sharing metadata.`);
}finally{rmSync(temp,{recursive:true,force:true});}
