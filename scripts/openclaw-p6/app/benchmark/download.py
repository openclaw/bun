#!/usr/bin/env python3
"""Host-only exact Actions download; the GitHub token never enters the container."""
import argparse,json,os,urllib.request
from pathlib import Path
from app_contract import dump,load,pins_ok,verify_export
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,request,fp,code,message,headers,newurl):
  redirected=super().redirect_request(request,fp,code,message,headers,newurl)
  if redirected is not None:redirected.remove_header('Authorization')
  return redirected

def main():
 p=argparse.ArgumentParser();p.add_argument('--pins',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
 pins=load(a.pins);pins_ok(pins);assert not a.out.exists();a.out.mkdir(parents=True)
 def fetch(path,target=None,limit=None):
  req=urllib.request.Request('https://api.github.com/repos/openclaw/bun/'+path,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
  with urllib.request.build_opener(Redirect).open(req,timeout=60) as response:
   if target is None:return json.load(response)
   count=0
   with target.open('xb') as f:
    while block:=response.read(1024*1024):
     count+=len(block);assert count<=limit;f.write(block)
   assert count==limit
 run=fetch(f"actions/runs/{pins['runId']}/attempts/{pins['runAttempt']}")
 metadata=fetch(f"actions/artifacts/{pins['artifact']['id']}")
 dump(a.out/'pins.json',pins);dump(a.out/'run.json',run);dump(a.out/'artifact.json',metadata)
 archive=a.out/'app.zip';fetch(f"actions/artifacts/{pins['artifact']['id']}/zip",archive,pins['artifact']['zipBytes'])
 verified=verify_export(pins,run,metadata,archive,a.out/'export')
 dump(a.out/'verification.json',verified);print(json.dumps(verified))
if __name__=='__main__':main()
