const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
test('publishing stages explicit pages and the manifest while leaving unrelated edits alone',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'demo-publish-'));
  const repo=path.join(temp,'repo'),remote=path.join(temp,'remote.git');fs.mkdirSync(repo);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:'pipe'}).trim();
  try{
    execFileSync('git',['init','--bare',remote],{stdio:'pipe'});git('init','-b','main');git('config','user.name','Publishing test');git('config','user.email','test@example.invalid');git('remote','add','origin',remote);
    fs.copyFileSync(path.join(__dirname,'../demo-push.sh'),path.join(repo,'demo-push.sh'));
    fs.writeFileSync(path.join(repo,'index.html'),'before');fs.writeFileSync(path.join(repo,'unrelated.txt'),'before');fs.writeFileSync(path.join(repo,'manifest.json'),'{}');git('add','.');git('commit','-m','Fixture');git('push','-u','origin','main');
    fs.writeFileSync(path.join(repo,'index.html'),'after');fs.writeFileSync(path.join(repo,'unrelated.txt'),'keep this edit local');fs.writeFileSync(path.join(repo,'draft.txt'),'untracked fixture');
    execFileSync('bash',['demo-push.sh','Publish homepage only','index.html'],{cwd:repo,stdio:'pipe'});
    assert.equal(git('show','HEAD:index.html'),'after');assert.equal(git('show','HEAD:unrelated.txt'),'before');
    assert.match(git('status','--short'),/unrelated\.txt/);assert.match(git('status','--short'),/draft\.txt/);
    assert.equal(git('ls-files','draft.txt'),'');assert.deepEqual(git('diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n').sort(),['index.html','manifest.json']);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
