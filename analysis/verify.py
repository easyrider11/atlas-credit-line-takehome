"""Third pass: check the claims DECISIONS.pdf leans on that the first passes left open."""
import csv, sys, collections, datetime as dt
from pathlib import Path
DATA = Path(sys.argv[1]); SNAP = dt.date(2026, 8, 25)
d = lambda s: dt.date.fromisoformat(s[:10]) if s else None
users = {r["user_id"]: r for r in csv.DictReader(open(DATA / "users.csv"))}
req = {r["user_id"]: r for r in csv.DictReader(open(DATA / "requests.csv"))}
room = lambda u: (int(u["max_eligible_limit_cents"]) - int(u["starting_limit_cents"])) // 100
def ret(rows, n=30):
    rows = [u for u in rows if (SNAP - d(u["joined_ts"])).days >= n]
    k = sum(1 for u in rows if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(u["joined_ts"])).days <= n)
    return f"{1-k/len(rows):.1%} (n={len(rows)})"
T = [u for u in users.values() if u["experiment_group"] == "treatment"]
C = [u for u in users.values() if u["experiment_group"] == "control"]

print("== 1. room>0 treatment members who never asked: do they look like control? ==")
print("  T room>0 no request:", ret([u for u in T if room(u) > 0 and u["user_id"] not in req]))
print("  T room>0 approved:  ", ret([u for u in T if room(u) > 0 and u["user_id"] in req]))
print("  C room>0:           ", ret([u for u in C if room(u) > 0]))

print("\n== 2. approved members closing 1 day after the request: excess churn or timing artifact? ==")
# If approval caused immediate closures, approved members' closure hazard in days 1-14 of
# tenure would sit above control's. Compare by tenure day, members observable >= 15d.
def by_tenure(rows):
    rows = [u for u in rows if (SNAP - d(u["joined_ts"])).days >= 15]
    c = collections.Counter((d(u["account_closed_ts"]) - d(u["joined_ts"])).days for u in rows if u["account_closed_ts"])
    return sum(c[i] for i in range(1, 15)) / len(rows)
appr = [u for u in T if room(u) > 0 and u["user_id"] in req]
print(f"  closed by day 14: T room>0 approved {by_tenure(appr):.2%}  C room>0 {by_tenure([u for u in C if room(u) > 0]):.2%}")
# Where do those early closers' requests sit? If requests were placed just before a closure that
# was coming anyway, request->close gaps pile up at 1 day without raising the tenure hazard.
early = [u for u in appr if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(u["joined_ts"])).days <= 14]
gap = collections.Counter(min((d(u["account_closed_ts"]) - d(req[u["user_id"]]["requested_ts"])).days, 8) for u in early)
print("  early closers, request->close gap (days):", sorted(gap.items()))

print("\n== 3. zero-room members who never asked: closed before they got the chance? ==")
z = [u for u in T if room(u) == 0 and u["user_id"] not in req]
zc = [u for u in z if u["account_closed_ts"]]
zl = sorted((d(u["account_closed_ts"]) - d(u["joined_ts"])).days for u in zc)
print(f"  n={len(z)} closed={len(zc)}; median tenure at close {zl[len(zl)//2]}d; open ones' 30d:",
      ret([u for u in z if not u["account_closed_ts"]] or z))
# Expected closures if they churned like control zero-room members over the same tenure.
cz = [u for u in C if room(u) == 0]
p14 = sum(1 for u in cz if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(u["joined_ts"])).days <= 14) / len(cz)
print(f"  control zero-room closed by day 14: {p14:.1%}")

print("\n== 4. headline sizes for the page ==")
share0 = sum(room(u) == 0 for u in users.values()) / len(users)
print(f"  zero-room share {share0:.1%}; zero-room asks declined: "
      f"{sum(1 for u in T if room(u)==0 and u['user_id'] in req and req[u['user_id']]['decision']=='DECLINED')}"
      f"/{sum(1 for u in T if room(u)==0 and u['user_id'] in req)}")
print(f"  projected 30d if room>0 get the flow and room=0 get control: "
      f"{(1-share0)*0.938 + share0*0.879:.1%} vs control 87.8%")

print("\n== 5. closure hazard BEFORE the member asked (exposure without a decision) vs control ==")
# At risk on tenure day t: open at start of t and, for treatment, no request before day t.
# A same-day request counts as "not yet asked" only if the close came first, which we can't
# order within a day, so same-day closes of requesters are excluded from the numerator.
def pre_hazard(rows, treat, a, b):
    at = cl = 0
    for u in rows:
        if (SNAP - d(u["joined_ts"])).days < b: continue
        j = d(u["joined_ts"]); c = (d(u["account_closed_ts"]) - j).days if u["account_closed_ts"] else 10**6
        r = (d(req[u["user_id"]]["requested_ts"]) - j).days if treat and u["user_id"] in req else 10**6
        for t in range(a, b):
            if c < t or r < t: break
            at += 1
            if c == t and r > t: cl += 1; break
    return cl / at if at else float("nan")
for lab, f in (("room=0", lambda u: room(u) == 0), ("room>0", lambda u: room(u) > 0)):
    tt = [u for u in T if f(u)]; cc = [u for u in C if f(u)]
    print(f"  {lab}: days 1-7 not-yet-asked T {pre_hazard(tt, True, 1, 8):.3%}/d  vs C {pre_hazard(cc, False, 1, 8):.3%}/d")

print("\n== 6. after day 14: hazard by what happened (members open at day 15, observable to day 30) ==")
def late(rows):
    rows = [u for u in rows if (SNAP - d(u["joined_ts"])).days >= 30 and
            (not u["account_closed_ts"] or (d(u["account_closed_ts"]) - d(u["joined_ts"])).days >= 15)]
    k = sum(1 for u in rows if u["account_closed_ts"] and (d(u["account_closed_ts"]) - d(u["joined_ts"])).days <= 30)
    return f"{k/len(rows):.2%} closed d15-30 (n={len(rows)})"
for lab, rows in (("C all", C),
                  ("T room>0 approved", [u for u in T if room(u) > 0 and u["user_id"] in req]),
                  ("T room>0 never asked", [u for u in T if room(u) > 0 and u["user_id"] not in req]),
                  ("T room=0 declined", [u for u in T if room(u) == 0 and u["user_id"] in req]),
                  ("T room=0 never asked", [u for u in T if room(u) == 0 and u["user_id"] not in req])):
    print(f"  {lab:<22} {late(rows)}")
