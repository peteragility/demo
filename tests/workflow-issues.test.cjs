const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const cases=[
 ['llm-pricing-v2-review.yml','Open, update or close the review issue','llm-pricing-v2-issue.md'],
 ['lakebase-source-review.yml','Reconcile review issue','lakebase-review/issue.md'],
 ['content-source-review.yml','Reconcile source review issue','content-review/issue.md']
];
for(const [file,step,report]of cases)test(file+' never closes an issue when publication fails',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-issue-'));
 try{
  const yaml=fs.readFileSync(path.join(root,'.github/workflows',file),'utf8');
  const section=yaml.split('      - name: '+step+'\n')[1].split(/\n      - /)[0];
  const script=section.split('        run: |\n')[1].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
  const gh=path.join(temp,'gh'),log=path.join(temp,'calls');
  fs.writeFileSync(gh,'#!/bin/bash\nprintf "%s\\n" "$*" >> "$GH_LOG"\nif [ "$1 $2" = "issue list" ]; then echo 42; fi\n');fs.chmodSync(gh,0o755);
  fs.mkdirSync(path.dirname(path.join(temp,report)),{recursive:true});
  for(const outcome of ['failure','skipped','success']){
   fs.writeFileSync(path.join(temp,report),'');fs.writeFileSync(log,'');
   const runnable=script.replaceAll('${{ steps.publish.outcome }}',outcome);
   execFileSync('bash',['-e','-c',runnable],{env:{...process.env,PATH:temp+path.delimiter+process.env.PATH,RUNNER_TEMP:temp,GH_LOG:log,PUBLISHED:outcome},stdio:'pipe'});
   const calls=fs.readFileSync(log,'utf8');
   assert.equal(calls.includes('issue close'),outcome==='success',outcome+'\n'+calls);
   if(outcome!=='success')assert.ok(calls.includes('issue edit'),calls);
  }
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
