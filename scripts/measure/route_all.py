# Routes the first prompt of every past session whose main model was Opus or Fable, 4 at a time, with the
# installed Model Pilot build. Resumable.
#   python3 -I scripts/measure/route_all.py SESSIONS.json OUT.jsonl
import json, sys, subprocess, os, concurrent.futures as cf
S=[s for s in json.load(open(sys.argv[1])) if any(k in max(s["models"],key=s["models"].get) for k in ("opus","fable"))]
out=sys.argv[2]; done={}
if os.path.exists(out): done={json.loads(l)["file"]:1 for l in open(out)}
todo=[s for s in S if s["file"] not in done]; print(len(S),"eligible,",len(todo),"to route",flush=True)
def route(s):
    for attempt in range(3):
        p=subprocess.run(["bb","auto","route",s["prompt"]],capture_output=True,text=True,timeout=120)
        try:
            r=json.loads(p.stdout); return {"file":s["file"],"route":r["route"],"delegation":r.get("delegation"),"jev":r.get("jev") or r.get("classifier")}
        except Exception: err=p.stderr[-300:]
    return {"file":s["file"],"error":err}
with cf.ThreadPoolExecutor(4) as ex, open(out,"a") as f:
    for i,r in enumerate(ex.map(route,todo)):
        f.write(json.dumps(r)+"\n"); f.flush()
        if i%20==0: print(i,flush=True)
print("done")
