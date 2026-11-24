import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('five merges and one closed anomaly produce one alert and one daily summary', () => {
  const py = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('a88',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
old={str(i):{'head':'a','base':'main','draft':False} for i in range(1,7)}
r,a,u=m.classify_pr_diff(old,{},lambda n:'CLOSED' if n=='6' else 'MERGED',lambda *_:None)
alert,summary,tally=m.alerts_and_summary(r,a,u,{'date':'2026-11-23','routine':4,'anomalies':0,'unknown':0},'2026-11-24')
print(json.dumps({'routine':r,'anomalies':a,'unknown':u,'alert':alert,'summary':summary,'tally':tally}))`;
  const run = spawnSync('python3', ['-c', py, join(import.meta.dir, 'a88_diff.py')], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const data = JSON.parse(run.stdout);
  expect(data.routine).toHaveLength(5);
  expect(data.anomalies).toHaveLength(1);
  expect(data.alert).toContain('PR #6 closed without merge');
  expect(data.summary).toContain('요약');
  expect(data.unknown).toEqual([]);
});

test('unknown departure and ancestry are not classified as alerts', () => {
  const py = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('a88',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
old={'1':{'head':'a'},'2':{'head':'b'}};new={'2':{'head':'c'}}
print(json.dumps(m.classify_pr_diff(old,new,lambda n:None,lambda *args:None)))`;
  const run = spawnSync('python3', ['-c', py, join(import.meta.dir, 'a88_diff.py')], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const [routine, anomalies, unknown] = JSON.parse(run.stdout);
  expect(routine).toEqual([]); expect(anomalies).toEqual([]); expect(unknown).toHaveLength(2);
});

test('watcher sends one alarm and one daily summary for a mixed diff', () => {
  const py = `import contextlib,datetime,importlib.util,io,json,pathlib,sys,tempfile
sys.path.insert(0,sys.argv[1]);s=importlib.util.spec_from_file_location('watch',str(pathlib.Path(sys.argv[1])/'a88_watch.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
with tempfile.TemporaryDirectory() as t:
 p=pathlib.Path(t);w.STATE=p/'state.json';w.REPORT=p/'report.md';w.HOSTS=()
 yesterday=(datetime.datetime.now().astimezone().date()-datetime.timedelta(days=1)).isoformat()
 w.STATE.write_text(json.dumps({'hosts':{},'prs':{str(i):{'head':'a'} for i in range(1,7)},'daily':{'date':yesterday,'routine':2,'anomalies':0,'unknown':0}}))
 w.prs_probe=lambda:{};w.closure=lambda n:'CLOSED' if n=='6' else 'MERGED';sent=[];w.post=lambda body:(sent.append(body) or True)
 with contextlib.redirect_stdout(io.StringIO()):w.main()
 print(json.dumps({'sent':sent,'ledger':w.REPORT.read_text(),'state':json.loads(w.STATE.read_text())}))`;
  const run = spawnSync('python3', ['-c', py, import.meta.dir], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result.sent).toHaveLength(2);
  expect(result.sent.filter((m: string) => m.startsWith('🚨'))).toHaveLength(1);
  expect(result.sent.filter((m: string) => m.includes('요약'))).toHaveLength(1);
  expect(result.ledger).toContain('PR #6 closed without merge');
  expect(result.state.pending_alerts).toEqual([]);
});

test('a failed PR list retains the previous snapshot for recovery', () => {
  const py = `import contextlib,datetime,importlib.util,io,json,pathlib,sys,tempfile
sys.path.insert(0,sys.argv[1]);s=importlib.util.spec_from_file_location('watch',str(pathlib.Path(sys.argv[1])/'a88_watch.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
with tempfile.TemporaryDirectory() as t:
 p=pathlib.Path(t);w.STATE=p/'state.json';w.REPORT=p/'report.md';w.HOSTS=()
 old={'6':{'head':'a'}};today=datetime.datetime.now().astimezone().date().isoformat()
 w.STATE.write_text(json.dumps({'hosts':{},'prs':old,'daily':{'date':today,'routine':0,'anomalies':0,'unknown':0}}))
 snapshots=iter([{'error':'unavailable'},{}]);w.prs_probe=lambda:next(snapshots);w.closure=lambda n:'CLOSED';sent=[];w.post=lambda body:(sent.append(body) or True)
 with contextlib.redirect_stdout(io.StringIO()):w.main();w.main()
 print(json.dumps({'sent':sent,'ledger':w.REPORT.read_text(),'state':json.loads(w.STATE.read_text())}))`;
  const run = spawnSync('python3', ['-c', py, import.meta.dir], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result.ledger).toContain('PR 목록 관측 실패');
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0]).toContain('PR #6 closed without merge');
  expect(result.state.last_good_prs).toEqual({});
});
