// Conservative pattern scan: report paths and commit IDs, never matched values.
// This is an additional check, not a substitute for comprehensive secret scanning.
import { execFileSync } from 'node:child_process';
const git=(args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});
const revisions=git(['rev-list','--all']).trim().split('\n').filter(Boolean);
const pattern=['(sk_live_|rk_live_)[A-Za-z0-9]{20,}','(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}','github_pat_[A-Za-z0-9_]{30,}','[A-Za-z0-9_-]{23,28}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}','discord(app)?\\.com/api/webhooks/[0-9]{17,20}/[A-Za-z0-9_-]{50,}','-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'].join('|');
let hits=0;
for(const sha of revisions){
 try{
 const result=git(['grep','-I','-l','-E','-e',pattern,sha,'--']);
 for(const line of result.trim().split('\n').filter(Boolean)){console.error('Potential secret:',line);hits++;}
 }catch(e){if(e.status!==1)throw e;}
}
console.log('Scanned '+revisions.length+' reachable commits; potential matches: '+hits);
if(hits)process.exitCode=1;
