#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse, csv, datetime, json, os, pathlib, re, shlex, subprocess, sys, tempfile

ITEMS = ('access','space','mirror','version','images','auth','pods','loops','clock')
K3S_KUBECTL = 'if [ -n "${KUBECONFIG:-}" ]; then command kubectl "$@"; elif command kubectl config view --minify >/dev/null 2>&1; then command kubectl "$@"; elif [ -r "$HOME/.kube/elanous-host-readiness-k3s.yaml" ]; then KUBECONFIG="$HOME/.kube/elanous-host-readiness-k3s.yaml" command kubectl "$@"; else command kubectl "$@"; fi'
def call(argv, timeout=30):
    try: return subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e: return subprocess.CompletedProcess(argv, 124, '', str(e))
def ssh(host, script, timeout=30):
    return call(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes',host,'bash -lc '+shlex.quote(script)], timeout)
def ok(host, script, timeout=30): return ssh(host, script, timeout).returncode == 0
def local(argv): return call(argv).returncode == 0

def evaluate_mirror_lag(graph_repo, mirror_sha, origin_sha, now_epoch, max_commits, max_minutes):
    """Return status and evidence from a locally available commit graph."""
    for sha in (mirror_sha, origin_sha):
        if not re.fullmatch(r'[0-9a-f]{40}',sha): return 'UNMEASURED','invalid SHA evidence'
        if call(['git','-C',graph_repo,'cat-file','-e',sha+'^{commit}']).returncode!=0:
            return 'UNMEASURED','HQ commit graph lacks '+sha[:8]
    ancestor=call(['git','-C',graph_repo,'merge-base','--is-ancestor',mirror_sha,origin_sha])
    if ancestor.returncode==1: return 'FAIL','mirror main is not an ancestor of origin/main'
    if ancestor.returncode!=0: return 'UNMEASURED','ancestry check unavailable'
    revs=call(['git','-C',graph_repo,'rev-list','--reverse',mirror_sha+'..'+origin_sha])
    if revs.returncode!=0: return 'UNMEASURED','lag commit list unavailable'
    missing=revs.stdout.splitlines()
    if not missing: return 'PASS','mirror equals origin/main (behind=0)'
    first=call(['git','-C',graph_repo,'show','-s','--format=%ct',missing[0]])
    try: age_seconds=now_epoch-int(first.stdout.strip())
    except ValueError: return 'UNMEASURED','first missing commit time unavailable'
    if first.returncode!=0 or age_seconds < -300: return 'UNMEASURED','first missing commit clock invalid'
    age_minutes=max(0,age_seconds)/60
    evidence=f'behind={len(missing)} commits; first-missing-age={age_minutes:.1f}m; limits={max_commits} commits/{max_minutes}m'
    return ('PASS' if len(missing)<=max_commits and age_minutes<=max_minutes else 'FAIL'),evidence

def mirror_probe(host,e):
    cmd='git --git-dir '+shlex.quote(e['mirror_path'])+' rev-parse refs/heads/main'
    observed=ssh(host,cmd)
    if observed.returncode!=0: return 'FAIL','remote mirror main unavailable'
    mirror_sha=observed.stdout.strip()
    source=e['source_repo']
    remote_url=call(['git','-C',source,'remote','get-url','origin']).stdout.strip()
    candidates=[source]+([remote_url] if pathlib.Path(remote_url).is_absolute() else [])
    for graph in candidates:
        if all(call(['git','-C',graph,'cat-file','-e',sha+'^{commit}']).returncode==0 for sha in (mirror_sha,e['sha'])):
            return evaluate_mirror_lag(graph,mirror_sha,e['sha'],int(datetime.datetime.now(datetime.timezone.utc).timestamp()),e['mirror_max_behind_commits'],e['mirror_max_lag_minutes'])
    return 'UNMEASURED','HQ commit graph lacks mirror/origin commit; no fetch in check-only mode'

def probe(host, item, e):
    if item == 'access':
        return local(['tailscale','status']) and ok(host, "tailscale status --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get(\"BackendState\")==\"Running\" else 1)'")
    if item == 'space':
        return ok(host, "df -P / /tmp | awk 'NR>1 {gsub(/%/,\"\",$5); if ($5>=85) bad=1} END{exit bad}'")
    if item == 'mirror':
        return mirror_probe(host,e)[0]=='PASS'
    if item == 'version':
        return ok(host, f'test "$(elanous --version 2>/dev/null)" = {shlex.quote(e["version"])}')
    if item == 'images':
        return ok(host, 'docker image inspect '+shlex.quote(e['gate_image'])+' '+shlex.quote(e['harness_image'])+' >/dev/null 2>&1')
    if item == 'auth':
        # The product access-only resolver rejects a stale or expiring owner mirror. One probe call; no owner refresh on worker.
        cmd="gh auth status >/dev/null 2>&1 && ELANOUS_REMOTE_CODEX_ACCESS_ONLY=1 elanous llm detect --probe --json | python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if any(c.get(\"provider\")==\"openai-codex\" and c.get(\"probe\",{}).get(\"success\") is True for c in x.get(\"candidates\",[])) else 1)'"
        return ok(host, cmd, 90)
    if item == 'pods':
        checks="kubectl config view --minify >/dev/null 2>&1 && kubectl get nodes --no-headers | grep -q ' Ready ' && kubectl get pods -A --no-headers | awk '$4==\"Error\"||$4==\"Unknown\"||$4==\"ContainerStatusUnknown\"{bad=1} END{exit (NR==0||bad)}'"
        if e['role']=='warm':
            checks += ''' && kubectl get pods -A -o json | python3 -c 'import json,sys; pods=json.load(sys.stdin)["items"]; sys.exit(0 if any("warm" in p.get("metadata",{}).get("name","").lower() and p.get("status",{}).get("phase")=="Running" and any(c.get("type")=="Ready" and c.get("status")=="True" for c in p.get("status",{}).get("conditions",[])) for p in pods) else 1)' '''
        cmd=f"if systemctl cat k3s.service >/dev/null 2>&1; then test -d /mirror-host/elanous-agent.git && systemctl is-active --quiet k3s && {{ kubectl() {{ {K3S_KUBECTL}; }}; {checks}; }}; else k3d cluster list -o json 2>/dev/null | grep -q 'elanous' && {{ {checks}; }}; fi"
        return ok(host, cmd)
    if item == 'loops':
        return ok(host, 'systemctl --user is-active --quiet '+shlex.quote(e['train_service'])+' && systemctl --user is-active --quiet '+shlex.quote(e['sync_service']))
    return ok(host, 'timedatectl show -p NTPSynchronized --value | grep -qx yes')

def repair(host, item, e):
    if item=='mirror':
        # HQ is the mirror owner; its existing push transport is the repair path.
        target='ssh://'+host+e['mirror_path']
        return call(['git','-C',e['source_repo'],'push',target,e['sha']+':refs/heads/main'],90).returncode==0
    pod_guard='''kubectl get pods -A -o json | python3 -c 'import json,sys; x=json.load(sys.stdin); active=[p for p in x.get("items",[]) if p.get("status",{}).get("phase") in ("Pending","Running") and p.get("metadata",{}).get("namespace") not in ("kube-system","kube-public","kube-node-lease")]; sys.exit(1 if active else 0)' '''
    native_kubectl='kubectl() { '+K3S_KUBECTL+'; }; '
    if item=='pods':
        native_k3s=ok(host,'systemctl cat k3s.service >/dev/null 2>&1')
        if native_k3s:
            # A missing native-k3s hostPath is a dependency failure; restarting cannot create its source.
            if not ok(host,'test -d /mirror-host/elanous-agent.git'): return False
        elif not ok(host,"k3d cluster list -o json 2>/dev/null | grep -q 'elanous'"):
            return False
        kubeconfig_repair='''systemctl cat k3s.service >/dev/null 2>&1 && sudo -n test -r /etc/rancher/k3s/k3s.yaml || exit 1
          mkdir -p "$HOME/.kube" &&
          # Source: OP 2026-11-10 requested a user-readable k3s kubeconfig with mode 0600.
          sudo -n install -o "$USER" -g "$(id -gn)" -m 600 /etc/rancher/k3s/k3s.yaml "$HOME/.kube/elanous-host-readiness-k3s.yaml" &&
          profile_line='export KUBECONFIG="$HOME/.kube/elanous-host-readiness-k3s.yaml"' &&
          { grep -Fqx "$profile_line" "$HOME/.profile" 2>/dev/null || printf '\\n%s\\n' "$profile_line" >> "$HOME/.profile"; } &&
          export KUBECONFIG="$HOME/.kube/elanous-host-readiness-k3s.yaml" && kubectl config view --minify >/dev/null 2>&1'''
        if native_k3s and not ok(host,native_kubectl+'kubectl config view --minify >/dev/null 2>&1'):
            if not ok(host,'sudo -n test -r /etc/rancher/k3s/k3s.yaml'):
                return False
            if not ok(host,kubeconfig_repair): return False
            if probe(host,item,e): return True
        # Unknown labels must fail closed too: any active application Pod blocks a cluster restart.
        if native_k3s and ok(host,'systemctl is-active --quiet k3s') and not ok(host,native_kubectl+pod_guard): return False
        if not native_k3s: return False
    fixes={
      'access': 'sudo -n systemctl restart tailscaled',
      'space': 'find /tmp -xdev -type f -mtime +7 -user "$USER" -delete',
      'version': 'elanous self-update --auto',
      'images': 'docker pull '+shlex.quote(e['gate_image'])+' && docker pull '+shlex.quote(e['harness_image']),
      'auth': 'systemctl --user restart elanous-codex-access-mirror.service',
      'pods': native_kubectl+'''if systemctl is-active --quiet k3s; then '''+pod_guard+''' && sudo -n systemctl restart k3s; else sudo -n systemctl restart k3s; fi && kubectl get pods -A --field-selector=status.phase=Failed -o json | python3 -c 'import json,sys,datetime; now=datetime.datetime.now(datetime.timezone.utc); print("\\n".join(p["metadata"]["namespace"]+"/"+p["metadata"]["name"] for p in json.load(sys.stdin).get("items",[]) if (now-datetime.datetime.fromisoformat(p["metadata"]["creationTimestamp"].replace("Z","+00:00"))).total_seconds()>86400))' | while read -r pod; do test -z "$pod" || kubectl delete pod -n "${pod%%/*}" "${pod#*/}" --wait=false; done''',
      'loops': 'systemctl --user restart '+shlex.quote(e['train_service'])+' '+shlex.quote(e['sync_service']),
      'clock': 'sudo -n timedatectl set-ntp true',
    }
    return ok(host, fixes[item], 90)

def append(path, rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    fresh=not path.exists()
    with path.open('a',newline='') as f:
        w=csv.writer(f,delimiter='\t',lineterminator='\n')
        if fresh:w.writerow(('host','item','status','repaired','at','detail'))
        w.writerows(rows)
        f.flush(); os.fsync(f.fileno())

def restore(path, host, caps):
    if caps<1: raise ValueError('--caps must be positive for READY')
    if not path.exists(): raise ValueError('host-caps.tsv missing')
    lines=path.read_text().splitlines()
    header=lines[0].split('\t')
    if not {'host','caps'} <= set(header): raise ValueError('host-caps.tsv lacks host/caps columns')
    hi,ci=header.index('host'),header.index('caps')
    matches=[i for i in range(1,len(lines)) if lines[i].split('\t')[hi]==host]
    if len(matches)!=1: raise ValueError('host-caps.tsv requires exactly one host row')
    fields=lines[matches[0]].split('\t'); fields[ci]=str(caps); lines[matches[0]]='\t'.join(fields)
    fd,tmp=tempfile.mkstemp(dir=path.parent,prefix='.host-caps-ready-')
    try:
        with os.fdopen(fd,'w') as f: f.write('\n'.join(lines)+'\n')
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def main():
    p=argparse.ArgumentParser(description='OP HQ host rejoin readiness; run on mbp')
    p.add_argument('host'); p.add_argument('--version',help='expected deployed rail version; never inferred from HQ installation'); p.add_argument('--gate-image'); p.add_argument('--harness-image')
    p.add_argument('--role',choices=('gate-train','warm'),default='gate-train',help='warm Pod required only for warm hosts')
    p.add_argument('--mirror-path',help='absolute aws1 bare mirror path confirmed by OP')
    # main moves every few minutes while HQ pushes the mirror asynchronously. Thirty minutes
    # covers several normal push windows; 60 commits caps burst drift. Either breach blocks admission.
    p.add_argument('--mirror-max-behind-commits',type=int,default=60)
    p.add_argument('--mirror-max-lag-minutes',type=int,default=30)
    p.add_argument('--train-service',help='aws1 train worker systemd user unit confirmed by OP')
    p.add_argument('--sync-service',help='aws1 main-sync systemd user unit confirmed by OP')
    mode=p.add_mutually_exclusive_group()
    mode.add_argument('--check-only',action='store_true',help='read-only inspection (default)')
    mode.add_argument('--repair',action='store_true',help='attempt one repair and recheck per failed item')
    p.add_argument('--caps',type=int,default=0); p.add_argument('--caps-file',type=pathlib.Path,default=pathlib.Path.home()/'elanous-hq/seat-state/OP/host-caps.tsv')
    p.add_argument('--ledger',type=pathlib.Path,default=pathlib.Path.home()/'elanous-hq/seat-state/OP/host-readiness.tsv')
    a=p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',a.host):p.error('invalid host')
    if a.mirror_path and not pathlib.PurePosixPath(a.mirror_path).is_absolute():p.error('--mirror-path must be an absolute remote path')
    if a.mirror_max_behind_commits<0 or a.mirror_max_lag_minutes<0:p.error('mirror lag limits must be nonnegative')
    repo=pathlib.Path.home()/'source/elanous-agent'
    origin=call(['git','-C',str(repo),'ls-remote','origin','refs/heads/main'])
    current_main=origin.stdout.split('\t')[0].strip() if origin.returncode==0 else ''
    if not re.fullmatch(r'[0-9a-f]{40}',current_main):current_main=''
    e={'sha':current_main,
       'version':a.version or '',
       'gate_image':a.gate_image or '', 'harness_image':a.harness_image or '',
       'mirror_path':a.mirror_path or '', 'source_repo':str(repo), 'role':a.role,
       'mirror_max_behind_commits':a.mirror_max_behind_commits,'mirror_max_lag_minutes':a.mirror_max_lag_minutes,
       'train_service':a.train_service or '', 'sync_service':a.sync_service or ''}
    at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    rows=[]; failures=[]
    if not ok(a.host,'echo ready'):
        rows=[(a.host,item,'UNMEASURED','no',at,'reason=no-access-from-'+os.uname().nodename) for item in ITEMS]
        verdict='UNMEASURED'; detail='reason=no-access-from-'+os.uname().nodename
    else:
        for item in ITEMS:
            missing= item=='mirror' and not (e['sha'] and e['mirror_path']) or item=='version' and not e['version'] or item=='images' and not (e['gate_image'] and e['harness_image']) or item=='loops' and not (e['train_service'] and e['sync_service'])
            if missing:
                rows.append((a.host,item,'UNMEASURED','no',at,'expected mirror path, service unit, deployed version, or image pin unavailable'))
                continue
            elif item=='mirror':
                status,detail=mirror_probe(a.host,e)
                if status=='FAIL' and a.repair and repair(a.host,item,e):
                    status,detail=mirror_probe(a.host,e)
                    if status=='PASS':status='REPAIRED'
                if status=='FAIL':failures.append(item)
                rows.append((a.host,item,status,'yes' if status=='REPAIRED' else 'no',at,detail))
                continue
            else:
                passed=probe(a.host,item,e); repaired=False; detail='probe failed' if not passed else 'probe passed'
                if not passed and a.repair:
                    repaired=repair(a.host,item,e) and probe(a.host,item,e)
            status='REPAIRED' if repaired else 'PASS' if passed else 'FAIL'
            if status=='FAIL': failures.append(item)
            rows.append((a.host,item,status,'yes' if repaired else 'no',at,detail))
        unmeasured=[r[1] for r in rows if r[2]=='UNMEASURED']
        verdict='BLOCKED' if failures else 'UNMEASURED' if unmeasured else 'READY'; detail=','.join(failures or unmeasured)
    rows.append((a.host,'verdict',verdict,'no',at,detail))
    try:
        append(a.ledger,rows)
    except OSError as exc:
        print(json.dumps({'host':a.host,'verdict':'UNMEASURED','reason':'ledger-write-failed','error':str(exc)},ensure_ascii=False))
        return 2
    if verdict=='READY' and a.repair:
        try:restore(a.caps_file,a.host,a.caps)
        except Exception as exc:
            verdict='BLOCKED'; detail='capacity'; failures.append('capacity')
            failed_rows=[(a.host,'capacity','FAIL','no',at,str(exc)),(a.host,'verdict','BLOCKED','no',at,'capacity')]
            rows.extend(failed_rows)
            try:append(a.ledger,failed_rows)
            except OSError:pass
    if verdict!='READY':call(['eln','msg','post','--from','R-READY','--to','OP','--body',f'HOST-REJOIN-READINESS {a.host} {verdict}: {detail}; ledger={a.ledger}'],20)
    print(json.dumps({'host':a.host,'verdict':verdict,'rows':rows},ensure_ascii=False))
    return 0 if verdict=='READY' else 2 if verdict=='UNMEASURED' else 1
sys.exit(main())
PY
