"""Does increase size matter? Plus churn timing and cohort stability."""
import csv, sys, collections, datetime as dt
from pathlib import Path
DATA = Path(sys.argv[1]); SNAP = dt.date(2026, 8, 25)
d = lambda s: dt.date.fromisoformat(s[:10]) if s else None
users = {r["user_id"]: r for r in csv.DictReader(open(DATA / "users.csv"))}
req = {r["user_id"]: r for r in csv.DictReader(open(DATA / "requests.csv"))}
room = lambda u: (int(u["max_eligible_limit_cents"]) - int(u["starting_limit_cents"])) // 100
inc = lambda u: (int(req[u["user_id"]]["requested_limit_cents"]) - int(u["starting_limit_cents"])) // 100
def ret(rows, n=30):
    rows = [u for u in rows if (SNAP - d(u["joined_ts"])).days >= n]
    if not rows: return "n/a"
    k = sum(1 for u in rows if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(u["joined_ts"])).days <= n)
    return f"{1-k/len(rows):.1%} (n={len(rows)})"
T = [u for u in users.values() if u["experiment_group"] == "treatment"]
C = [u for u in users.values() if u["experiment_group"] == "control"]
appr = [u for u in T if u["user_id"] in req and req[u["user_id"]]["decision"] == "APPROVED"]

print("== approved: 30d retention by share of room taken ==")
for lo, hi in ((0, .25), (.25, .5), (.5, .75), (.75, .999), (.999, 1.01)):
    print(f"  ask/room [{lo:.2f},{hi:.2f}):", ret([u for u in appr if lo <= inc(u) / room(u) < hi]))
print("== approved: by absolute ask ($) ==")
for lo, hi in ((0, 100), (100, 300), (300, 600), (600, 1000), (1000, 1600), (1600, 2600)):
    print(f"  ask [{lo},{hi}):", ret([u for u in appr if lo <= inc(u) < hi]))
print("== approved: by room bucket x took-all-room ==")
for r in (500, 1000, 1500, 2500):
    rs = [u for u in appr if room(u) == r]
    print(f"  room {r}: full={ret([u for u in rs if inc(u) == r])}  partial={ret([u for u in rs if inc(u) < r])}")

print("\n== approved members closing within 1 day of request: what did they ask? ==")
fast = [u for u in appr if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(req[u["user_id"]]["requested_ts"])).days <= 1]
print("  n", len(fast), "ask/room deciles", sorted(collections.Counter(min(int(10 * inc(u) / room(u)), 9) for u in fast).items()))
print("  all approved ask/room deciles", sorted(collections.Counter(min(int(10 * inc(u) / room(u)), 9) for u in appr).items()))
print("  join->request lag of fast closers", sorted(collections.Counter(min((d(req[u['user_id']]['requested_ts']) - d(u['joined_ts'])).days, 10) for u in fast).items()))

print("\n== zero-room treatment members who did NOT request ==")
z = [u for u in T if room(u) == 0]
print("  zero-room T:", len(z), "requested", sum(u["user_id"] in req for u in z))
print("  non-requesters 30d:", ret([u for u in z if u["user_id"] not in req]), " control zero-room:", ret([u for u in C if room(u) == 0]))
print("  zero-room asks $ dist (top):", collections.Counter(inc(u) for u in z if u["user_id"] in req).most_common(5), "min", min(inc(u) for u in z if u["user_id"] in req), "max", max(inc(u) for u in z if u["user_id"] in req))

print("\n== tenure day of closure (first 40 days), control vs treatment ==")
for name, g in (("control", C), ("T approved", appr), ("T declined", [u for u in T if u["user_id"] in req and req[u["user_id"]]["decision"] == "DECLINED"])):
    cd = collections.Counter(min((d(u["account_closed_ts"]) - d(u["joined_ts"])).days, 40) for u in g if u["account_closed_ts"])
    print(f"  {name:<11} n={len(g)}", [(k, cd[k]) for k in sorted(cd)][:40])

print("\n== cohort stability: 30d retention diff by join month and room>0 vs room=0 ==")
for m in ("2026-06", "2026-07"):
    for label, f in (("room>0", lambda u: room(u) > 0), ("room=0", lambda u: room(u) == 0)):
        print(f"  {m} {label}: T {ret([u for u in T if u['joined_ts'][:7]==m and f(u)])}  C {ret([u for u in C if u['joined_ts'][:7]==m and f(u)])}")
print("\n== balance: starting limit & room mix by group ==")
for g, rows in (("T", T), ("C", C)):
    print(" ", g, sorted(collections.Counter(room(u) for u in rows).items()), sorted(collections.Counter(int(u['starting_limit_cents'])//100 for u in rows).items()))
