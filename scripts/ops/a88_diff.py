"""Pure A88 classification: unresolved evidence is unknown, not an alarm or success."""

def classify_pr_diff(previous, current, closure, compare):
    routine, anomalies, unknown = [], [], []
    for number in sorted(set(previous) | set(current), key=int):
        old, new = previous.get(number), current.get(number)
        if old and not new:
            state = closure(number)
            if state == 'MERGED': routine.append(f'PR #{number} merged')
            elif state == 'CLOSED': anomalies.append(f'PR #{number} closed without merge')
            else: unknown.append(f'PR #{number} departure unmeasured')
        elif not old and new:
            routine.append(f'PR #{number} opened')
        elif old and new:
            if old.get('base') and new.get('base') and old['base'] != new['base']:
                anomalies.append(f'PR #{number} base changed')
            if old.get('draft') is False and new.get('draft') is True:
                anomalies.append(f'PR #{number} ready became draft')
            elif old.get('draft') is True and new.get('draft') is False:
                routine.append(f'PR #{number} draft became ready')
            if old.get('head') != new.get('head'):
                relation = compare(number, old.get('head'), new.get('head'))
                if relation in ('ahead', 'identical'): routine.append(f'PR #{number} head advanced')
                elif relation in ('behind', 'diverged'): anomalies.append(f'PR #{number} head rewound or diverged')
                else: unknown.append(f'PR #{number} head relation unmeasured')
    return routine, anomalies, unknown


def alerts_and_summary(routine, anomalies, unknown, prior_daily, today):
    """Return one combined alert, at most one completed-day summary, and next tally."""
    summary = None
    tally = dict(prior_daily or {})
    if tally.get('date') != today:
        if tally.get('date'):
            summary = f"A88 {tally['date']} 요약: 일상 {tally.get('routine',0)} · 이상 {tally.get('anomalies',0)} · 미측정 {tally.get('unknown',0)}"
        tally = dict(date=today, routine=0, anomalies=0, unknown=0)
    tally['routine'] += len(routine)
    tally['anomalies'] += len(anomalies)
    tally['unknown'] += len(unknown)
    alert = f"🚨 A88 이상 {len(anomalies)}건: " + '; '.join(anomalies) if anomalies else None
    return alert, summary, tally
