#!/usr/bin/env bash
set -euo pipefail
exec python3 - "$(dirname "$0")/host-readiness.sh" <<'PY'
"""Run the shipped entrypoint against fake transport and host CLIs."""
import json, os, pathlib, shutil, stat, subprocess, sys, tempfile, time
script=pathlib.Path(sys.argv[1]).resolve()
root=pathlib.Path(tempfile.mkdtemp(prefix='host-readiness-sim-'))
try:
    home=root/'home'; home.mkdir()
    bin_dir=root/'bin'; bin_dir.mkdir()
    state_file=root/'state.json'; event_file=root/'events.log'
    stub=bin_dir/'stub'
    stub.write_text('''#!/usr/bin/env python3
import json,os,pathlib,shlex,subprocess,sys
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
path=pathlib.Path(os.environ['FAKE_HOST_STATE']); state=json.loads(path.read_text())
def event(s):
 with open(os.environ['FAKE_HOST_EVENTS'],'a') as f:f.write(s+'\\n')
if name=='ssh':
 if state.get('transport') is False:sys.exit(255)
 command=shlex.split(args[-1])[-1]
 if 'test -d /mirror-host/elanous-agent.git' in command:
  command=command.replace('test -d /mirror-host/elanous-agent.git','true' if state.get('mirror_host_path',True) else 'false')
 remote_env=dict(os.environ)
 if state.get('remote_kubeconfig'):remote_env['KUBECONFIG']=state['remote_kubeconfig']
 sys.exit(subprocess.run(['bash','-c',command],env=remote_env).returncode)
if name=='tailscale':
 if state.get('access') is False:sys.exit(1)
 if '--json' in args:print(json.dumps({'BackendState':'Running'}))
 sys.exit(0)
if name=='df':
 pct='90%' if state.get('space') is False else '40%'
 print('Filesystem 1024-blocks Used Available Capacity Mounted on')
 print('/dev/root 100 40 60 '+pct+' /')
 print('/dev/tmp 100 40 60 '+pct+' /tmp')
 sys.exit(0)
if name=='systemctl':
 if 'cat' in args and 'k3s.service' in args:sys.exit(1 if state.get('k3s_installed') is False else 0)
 if 'restart' in args:
  event('systemctl restart '+' '.join(args))
  if 'k3s' in args:state['k3s_active']=True;path.write_text(json.dumps(state))
 if 'is-active' in args and 'k3s' in args and state.get('k3s_active') is False:sys.exit(1)
 if 'is-active' in args and state.get('loops') is False and '--user' in args:sys.exit(1)
 sys.exit(0)
if name=='kubectl':
 if args[:2]==['config','view']:
  expected=str(pathlib.Path(os.environ['HOME'])/'.kube/elanous-host-readiness-k3s.yaml')
  repaired=state.get('kubeconfig_repaired',False)
  if state.get('remote_kubeconfig') and os.environ.get('KUBECONFIG')!=state['remote_kubeconfig']:sys.exit(1)
  sys.exit(0 if state.get('kubeconfig_readable',True) and (not repaired or os.environ.get('KUBECONFIG')==expected) else 1)
 if state.get('k3s_active') is False:sys.exit(1)
 if args[:2]==['get','nodes']:
  print('node1 Ready control-plane 1d v1');sys.exit(0)
 if args[:2]==['get','pods']:
  if '--field-selector=status.phase=Failed' in args:
   print(json.dumps({'items':[]}));sys.exit(0)
  pods=state.get('pod_rows',[{'name':'gatepool','phase':'Running','ready':True,'status':'Running'}])
  if '-o' in args and args[args.index('-o')+1]=='json':
   print(json.dumps({'items':[{'metadata':{'name':p['name'],'namespace':p.get('namespace','default'),'creationTimestamp':'2026-11-09T00:00:00Z'},'status':{'phase':p['phase'],'conditions':[{'type':'Ready','status':'True' if p['ready'] else 'False'}]}} for p in pods]}));sys.exit(0)
  for p in pods:print(p.get('namespace','default'),p['name'],'1/1' if p['ready'] else '0/1',p['status'],'0','1m')
  sys.exit(0)
if name=='k3d':print('elanous');sys.exit(0)
if name=='docker':sys.exit(1 if state.get('images') is False else 0)
if name=='gh':sys.exit(1 if state.get('auth') is False else 0)
if name=='elanous':
 if args==['--version']:
  print('0.3.7' if state.get('version') is False else '0.3.8-dev.0');sys.exit(0)
 if args[:2]==['self-update','--auto']:
  state['version']=True;path.write_text(json.dumps(state));event('version repaired');sys.exit(0)
 if args[:2]==['llm','detect']:
  print(json.dumps({'candidates':[{'provider':'openai-codex','probe':{'success':True}}]}));sys.exit(0)
if name=='timedatectl':print('no' if state.get('clock') is False else 'yes');sys.exit(0)
if name=='eln':event('OP mail');sys.exit(0)
if name=='sudo':
 if args[:3]==['-n','test','-r']:sys.exit(0 if state.get('root_kubeconfig',True) else 1)
 if len(args)>2 and args[1:3]==['systemctl','restart'] and 'k3s' in args:
  event('sudo systemctl restart k3s');state['k3s_active']=True;path.write_text(json.dumps(state));sys.exit(0)
 if len(args)>1 and args[1]=='install':
  if not state.get('root_kubeconfig',True):sys.exit(1)
  event('sudo install '+' '.join(args[2:]))
  target=pathlib.Path(args[-1]); target.parent.mkdir(parents=True,exist_ok=True)
  target.write_text('apiVersion: v1\\nkind: Config\\n')
  # Source: OP 2026-11-10 requested a user-readable k3s kubeconfig with mode 0600.
  target.chmod(0o600)
  state['kubeconfig_readable']=True; state['kubeconfig_repaired']=True; state['kubeconfig_mode']='600'
  path.write_text(json.dumps(state)); sys.exit(0)
 sys.exit(1)
print('unexpected stub:',name,args,file=sys.stderr);sys.exit(99)
''')
    stub.chmod(0o755)
    for name in ('ssh','tailscale','df','systemctl','kubectl','k3d','docker','gh','elanous','timedatectl','eln','sudo'):
        (bin_dir/name).symlink_to(stub)
    env=dict(os.environ,HOME=str(home),PATH=str(bin_dir)+os.pathsep+os.environ['PATH'],
             FAKE_HOST_STATE=str(state_file),FAKE_HOST_EVENTS=str(event_file))
    source=home/'source/elanous-agent'; source.mkdir(parents=True)
    origin=root/'origin.git'; mirror=root/'mirror.git'
    def git(*args, cwd=None, extra_env=None):
        p=subprocess.run(['git',*args],cwd=cwd,env={**env,**(extra_env or {})},capture_output=True,text=True)
        assert p.returncode==0,(args,p.stderr)
        return p.stdout.strip()
    git('init','--bare','-q',str(origin)); git('init','--bare','-q',str(mirror))
    git('init','-q','-b','main',str(source))
    git('-C',str(source),'config','user.name','readiness-sim')
    git('-C',str(source),'config','user.email','sim@example.invalid')
    git('-C',str(source),'remote','add','origin',str(origin))
    now=int(time.time())
    def commit(ago):
        stamp=f'@{now-ago} +0000'
        git('-C',str(source),'commit','--allow-empty','-qm','sim',extra_env={'GIT_AUTHOR_DATE':stamp,'GIT_COMMITTER_DATE':stamp})
        return git('-C',str(source),'rev-parse','HEAD')
    base=commit(600)
    git('-C',str(source),'push','-q',str(origin),'HEAD:refs/heads/main')
    git('-C',str(source),'push','-q',str(mirror),'HEAD:refs/heads/main')
    latest=commit(120)
    git('-C',str(source),'push','-q',str(origin),'HEAD:refs/heads/main')
    ledger=root/'ledger.tsv'; caps=root/'caps.tsv'
    caps.write_text('host\tcaps\naws1\t0\n')
    args=['aws1','--check-only','--version','0.3.8-dev.0','--gate-image','gate:pin','--harness-image','harness:pin',
          '--mirror-path',str(mirror),'--train-service','train.service','--sync-service','sync.service',
          '--ledger',str(ledger),'--caps-file',str(caps),'--caps','3']
    def run(state=None,extra=(),ledger_path=None,caps_path=None):
        state_file.write_text(json.dumps(state or {})); event_file.write_text('')
        cmd=[str(script),*args]
        if ledger_path:cmd[cmd.index('--ledger')+1]=str(ledger_path)
        if caps_path:cmd[cmd.index('--caps-file')+1]=str(caps_path)
        if '--repair' in extra:cmd.remove('--check-only')
        cmd+=list(extra)
        result=subprocess.run(cmd,env=env,capture_output=True,text=True)
        try:body=json.loads(result.stdout)
        except json.JSONDecodeError:raise AssertionError((result.returncode,result.stdout,result.stderr))
        return result,body
    def result_item(body,item):return next(row for row in body['rows'] if row[1]==item)
    p,b=run()
    assert p.returncode==0 and b['verdict']=='READY' and result_item(b,'mirror')[2]=='PASS' and caps.read_text().endswith('\t0\n'),b
    p,b=run(extra=('--mirror-max-lag-minutes','1'))
    assert p.returncode==1 and result_item(b,'mirror')[2]=='FAIL',b
    for item in ('access','space','version','images','auth','pods','loops','clock'):
        state={item:False}
        if item=='pods':state={'pod_rows':[{'name':'junk','phase':'Failed','ready':False,'status':'Error'}]}
        p,b=run(state)
        assert p.returncode==1 and result_item(b,item)[2]=='FAIL',(item,b,p.stderr)
        assert caps.read_text().endswith('\t0\n')
    p,b=run({'transport':False})
    assert p.returncode==2 and all(row[2]=='UNMEASURED' for row in b['rows']),b
    # A supplied SHA cannot bypass the current origin query (the option was removed).
    git('-C',str(source),'remote','set-url','origin',str(root/'missing-origin.git'))
    p,b=run()
    assert p.returncode==2 and result_item(b,'mirror')[2]=='UNMEASURED',b
    git('-C',str(source),'remote','set-url','origin',str(origin))
    # A named warm Pod that is Pending or not Ready must not satisfy warm-role readiness.
    for phase,ready in [('Pending',False),('Running',False)]:
        p,b=run({'pod_rows':[{'name':'warm-spare','phase':phase,'ready':ready,'status':phase}]},extra=('--role','warm'))
        assert p.returncode==1 and result_item(b,'pods')[2]=='FAIL',b
    p,b=run({'pod_rows':[{'name':'warm-spare','phase':'Running','ready':True,'status':'Running'}]},extra=('--role','warm'))
    assert p.returncode==0 and result_item(b,'pods')[2]=='PASS',b
    (home/'.kube').mkdir(parents=True,exist_ok=True)
    (home/'.kube/config').write_text('existing-user-config-preserved')
    profile=home/'.profile'; profile.write_text('existing-profile-without-final-newline')
    p,b=run({'kubeconfig_readable':False},extra=('--repair',))
    assert p.returncode==0 and result_item(b,'pods')[2]=='REPAIRED',b
    assert state_file.read_text() and json.loads(state_file.read_text())['kubeconfig_mode']=='600'
    assert 'sudo install -o '+os.environ.get('USER','')+' -g ' in event_file.read_text() and '-m 600 /etc/rancher/k3s/k3s.yaml' in event_file.read_text()
    assert (home/'.kube/config').read_text()=='existing-user-config-preserved'
    assert profile.read_text().endswith('export KUBECONFIG="$HOME/.kube/elanous-host-readiness-k3s.yaml"\n')
    assert profile.read_text().count('export KUBECONFIG="$HOME/.kube/elanous-host-readiness-k3s.yaml"')==1
    assert stat.S_IMODE((home/'.kube/elanous-host-readiness-k3s.yaml').stat().st_mode) == stat.S_IRUSR | stat.S_IWUSR
    p,b=run({'kubeconfig_readable':False},extra=('--repair',))
    assert p.returncode==0 and result_item(b,'pods')[2]=='REPAIRED',b
    assert (home/'.kube/config').read_text()=='existing-user-config-preserved'
    assert profile.read_text().count('export KUBECONFIG="$HOME/.kube/elanous-host-readiness-k3s.yaml"')==1
    p,b=run({'kubeconfig_readable':False,'root_kubeconfig':False},extra=('--repair',))
    assert p.returncode==1 and result_item(b,'pods')[2]=='FAIL' and 'systemctl restart k3s' not in event_file.read_text(),b
    p,b=run({'mirror_host_path':False},extra=('--repair',))
    assert p.returncode==1 and result_item(b,'pods')[2]=='FAIL' and 'systemctl restart k3s' not in event_file.read_text(),b
    p,b=run({'k3s_active':False,'pod_rows':[{'name':'gatepool','namespace':'kube-system','phase':'Running','ready':True,'status':'Running'}]},extra=('--repair',))
    assert p.returncode==0 and result_item(b,'pods')[2]=='REPAIRED' and 'sudo systemctl restart k3s' in event_file.read_text(),b
    p,b=run({'k3s_installed':False,'remote_kubeconfig':'/existing/other-cluster.yaml','pod_rows':[{'name':'warm-spare','phase':'Running','ready':True,'status':'Running'}]},extra=('--role','warm'))
    assert p.returncode==0 and result_item(b,'pods')[2]=='PASS',b
    # A successful repair records READY before it edits host-caps.
    p,b=run({'version':False},extra=('--repair',))
    assert p.returncode==0 and result_item(b,'version')[2]=='REPAIRED' and caps.read_text().endswith('\t3\n'),b
    assert ledger.read_text().splitlines()[-1].split('\t')[2]=='READY'
    caps.write_text('host\tcaps\naws1\t0\n')
    # Ledger write refusal cannot restore a capacity row.
    bad_ledger=root/'unwritable-ledger';bad_ledger.mkdir()
    p,b=run({'version':False},extra=('--repair',),ledger_path=bad_ledger)
    assert p.returncode==2 and b['reason']=='ledger-write-failed' and caps.read_text().endswith('\t0\n'),b
    p,b=run(extra=('--repair',),caps_path=root/'missing-caps.tsv')
    assert p.returncode==1 and b['verdict']=='BLOCKED' and b['rows'][-1][2]=='BLOCKED',b
    assert ledger.read_text().splitlines()[-1].split('\t')[2]=='BLOCKED' and caps.read_text().endswith('\t0\n')
    # A live gate Pod blocks the k3s repair branch.
    p,b=run({'pod_rows':[{'name':'gate-0','phase':'Running','ready':True,'status':'Running'},
                          {'name':'junk','phase':'Failed','ready':False,'status':'Error'}]},extra=('--repair',))
    assert p.returncode==1 and result_item(b,'pods')[2]=='FAIL' and 'restart k3s' not in event_file.read_text(),b
    print('PASS: real entrypoint; 9 injected failures; origin lookup UNMEASURED; warm Running/Ready; kubeconfig repair preserves existing config, mode 0600 and profile idempotence; explicit KUBECONFIG on recheck; inactive native-k3s restart; missing hostPath fail-closed; ledger-before-caps failure; Pod repair guard')
finally:
    shutil.rmtree(root)
PY
