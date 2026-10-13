"""Second pass: heterogeneity, timing, durability, trends, power."""
import csv, sys, collections, datetime as dt, math
from pathlib import Path
DATA = Path(sys.argv[1]); SNAP = dt.date(2026, 8, 25)
d = lambda s: dt.date.fromisoformat(s[:10]) if s else None
users = {r["user_id"]: r for r in csv.DictReader(open(DATA / "users.csv"))}
req = {r["user_id"]: r for r in csv.DictReader(open(DATA / "requests.csv"))}
room = lambda u: (int(u["max_eligible_limit_cents"]) - int(u["starting_limit_cents"])) // 100
start = lambda u: int(u["starting_limit_cents"]) // 100
inc = lambda u: (int(req[u["user_id"]]["requested_limit_cents"]) - int(u["starting_limit_cents"])) // 100
lag = lambda u: (d(req[u["user_id"]]["requested_ts"]) - d(u["joined_ts"])).days
def ret(rows, n=30):
    rows = [u for u in rows if (SNAP - d(u["joined_ts"])).days >= n]
    if not rows: return float("nan"), 0
    k = sum(1 for u in rows if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(u["joined_ts"])).days <= n)
    return 1 - k / len(rows), len(rows)
fmt = lambda x: f"{x[0]:.1%} (n={x[1]})"
T = [u for u in users.values() if u["experiment_group"] == "treatment"]
C = [u for u in users.values() if u["experiment_group"] == "control"]

print("== 1. effect by starting limit x room>0 / =0 (30d) ==")
for s in sorted({start(u) for u in users.values()}):
    for lab, f in (("room=0", lambda u: room(u) == 0), ("room>0", lambda u: room(u) > 0)):
        t, c = ret([u for u in T if start(u) == s and f(u)]), ret([u for u in C if start(u) == s and f(u)])
        if t[1]: print(f"  start ${s} {lab}: T {fmt(t)}  C {fmt(c)}  diff {t[0]-c[0]:+.1%}")
print("  zero-room share by starting limit:", {s: f"{sum(room(u)==0 for u in users.values() if start(u)==s)/sum(1 for u in users.values() if start(u)==s):.0%}" for s in sorted({start(u) for u in users.values()})})

print("\n== 2. declined: does ask size or reason matter? (30d) ==")
dec = [u for u in T if u["user_id"] in req and req[u["user_id"]]["decision"] == "DECLINED"]
for lo, hi in ((0, 1000), (1000, 1800), (1800, 2600)):
    print(f"  ask [{lo},{hi}): {fmt(ret([u for u in dec if lo <= inc(u) < hi]))}")
for r in ("UTILIZATION_TOO_HIGH", "INSUFFICIENT_PAYMENT_HISTORY", "NEW_CREDIT_LINES"):
    print(f"  {r}: {fmt(ret([u for u in dec if req[u['user_id']]['decline_reason'] == r]))}")

print("\n== 3. durability: 30/45/60d by room stratum ==")
for lab, f in (("room=0", lambda u: room(u) == 0), ("room>0", lambda u: room(u) > 0)):
    for n in (30, 45, 60):
        t, c = ret([u for u in T if f(u)], n), ret([u for u in C if f(u)], n)
        print(f"  {lab} {n}d: T {fmt(t)} C {fmt(c)} diff {t[0]-c[0]:+.1%}")

print("\n== 4. daily closure hazard by tenure week (closures / members still open & observable) ==")
def hazard(rows, a, b):
    at_risk = closed = 0
    for u in rows:
        if (SNAP - d(u["joined_ts"])).days < b: continue
        cd = (d(u["account_closed_ts"]) - d(u["joined_ts"])).days if u["account_closed_ts"] else 10**6
        if cd < a: continue
        at_risk += 1; closed += a <= cd < b
    return closed / at_risk / (b - a) if at_risk else float("nan")
groups = {"C room>0": [u for u in C if room(u) > 0], "T room>0": [u for u in T if room(u) > 0],
          "C room=0": [u for u in C if room(u) == 0], "T room=0": [u for u in T if room(u) == 0]}
for a, b in ((1, 8), (8, 15), (15, 22), (22, 31), (31, 46), (46, 61)):
    print(f"  days {a:>2}-{b-1:<2}: " + "  ".join(f"{k} {hazard(v, a, b):.3%}/d" for k, v in groups.items()))

print("\n== 5. request timing ==")
rq = [u for u in T if u["user_id"] in req]
lc = collections.Counter(min(lag(u), 31) for u in rq)
print(f"  same day as join: {lc[0]/len(rq):.0%}; within 3 days: {sum(lc[i] for i in range(4))/len(rq):.0%}; within 7: {sum(lc[i] for i in range(8))/len(rq):.0%}; >30d: {lc[31]/len(rq):.1%}")
print("  hour of day (UTC) top:", collections.Counter(int(req[u['user_id']]['requested_ts'][11:13]) for u in rq).most_common(5))
print("  weekday:", sorted(collections.Counter(d(req[u['user_id']]['requested_ts']).weekday() for u in rq).items()))
for lab, f in (("room>0", lambda u: room(u) > 0), ("room=0", lambda u: room(u) == 0)):
    early = [u for u in rq if f(u) and lag(u) <= 3]; late = [u for u in rq if f(u) and 4 <= lag(u) <= 14]
    print(f"  {lab} asked d0-3: {fmt(ret(early))}  asked d4-14: {fmt(ret(late))}")

print("\n== 6. trend by join week: treatment effect by stratum (30d) ==")
wk = lambda u: d(u["joined_ts"]).isocalendar()[1]
for w in sorted({wk(u) for u in users.values()}):
    row = []
    for lab, f in (("room>0", lambda u: room(u) > 0), ("room=0", lambda u: room(u) == 0)):
        t, c = ret([u for u in T if wk(u) == w and f(u)]), ret([u for u in C if wk(u) == w and f(u)])
        if t[1]: row.append(f"{lab} {t[0]-c[0]:+.1%}")
    jn = sum(1 for u in users.values() if wk(u) == w)
    print(f"  wk{w} joins {jn:>6}: " + "  ".join(row))

print("\n== 7. $50 asks over time (share of approved asks that day) ==")
appr = [u for u in rq if req[u["user_id"]]["decision"] == "APPROVED"]
bymonth = collections.defaultdict(lambda: [0, 0])
for u in appr:
    m = req[u["user_id"]]["requested_ts"][:10]; bymonth[m][1] += 1; bymonth[m][0] += inc(u) == 50
ks = sorted(bymonth); print("  first/last day with $50:", min(k for k in ks if bymonth[k][0]), max(k for k in ks if bymonth[k][0]))
for k in ks[::10]: print(f"   {k}: {bymonth[k][0]/bymonth[k][1]:.1%} of {bymonth[k][1]}")

print("\n== 8. ask behaviour (room>0): share taking full room, by room ==")
for r in (500, 1000, 1500, 2500):
    rs = [u for u in appr if room(u) == r]
    print(f"  room {r}: took all {sum(inc(u)==r for u in rs)/len(rs):.1%}, asked exactly $500 {sum(inc(u)==500 for u in rs)/len(rs):.1%}, distinct asks {len({inc(u) for u in rs})}")

print("\n== 9. power for next test: room>0 members, baseline ~93.8% 30d ==")
p = 0.938; n_week = sum(1 for u in users.values() if room(u) > 0) / 10  # ~10 weeks of joins
for mde in (0.005, 0.01, 0.02):
    n = 2 * (1.96 + 0.84) ** 2 * p * (1 - p) / mde ** 2
    print(f"  MDE {mde:.1%}: {n:,.0f}/arm  ≈ {2*n/n_week:.1f} weeks of room>0 signups (+30d to read)")
