"""Scores DNS attribution: ground truth (dnsprobe.sh output) against the dns facts in the VM.
Usage: python3 dns-score.py truth.jsonl facts.json (see README: DNS lookups)"""
import collections
import json
import sys

truth = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
facts = [json.loads(body) for body in json.load(open(sys.argv[2]))]
by_name = collections.defaultdict(list)
for fact in facts:
    by_name[fact['name']].append(fact)

verdicts = collections.Counter()
gaps = []
print(f"{'case':28} {'name':32} {'verdict':12} gap_ms  candidates  attributed-to")
for row in truth:
    found = by_name.get(row['name'], [])
    if not found:
        verdict, gap, cand, got = 'NO_FACT', '', '', ''
    else:
        calls = {fact.get('call_id') for fact in found}
        named = [fact for fact in found if fact.get('call_id')]
        if not named:
            verdict = 'UNNAMED'
        elif calls == {row['call']}:
            verdict = 'RIGHT'
        elif row['call'] in calls:
            verdict = 'PARTLY'
        else:
            verdict = 'WRONG'
        gap = ','.join(str((fact.get('basis') or {}).get('gap_ms', '')) for fact in found)
        cand = ','.join(str(len((fact.get('basis') or {}).get('candidates') or ([1] if fact.get('call_id') else []))) for fact in found)
        got = ','.join(f"{fact.get('call_id')}/{fact.get('process')}/{fact.get('certainty')} x{fact.get('count')}" for fact in found)
        gaps += [(fact.get('basis') or {}).get('gap_ms') for fact in found if fact.get('call_id')]
    verdicts[verdict] += 1
    print(f"{row['case']:28} {row['name']:32} {verdict:12} {gap:7} {cand:11} {got}")
print(dict(verdicts))
gaps = sorted(gap for gap in gaps if isinstance(gap, (int, float)))
if gaps:
    print('gap ms: min', gaps[0], 'median', gaps[len(gaps) // 2], 'max', gaps[-1])
