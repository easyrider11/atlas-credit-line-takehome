"""Retention cuts. Metric: account still open N days after joining, among members
who had >= N days of tenure at the 2026-08-25 snapshot (removes censoring)."""
import csv, sys, collections, datetime as dt, math
from pathlib import Path

DATA = Path(sys.argv[1]); SNAP = dt.date(2026, 8, 25)
d = lambda s: dt.date.fromisoformat(s[:10]) if s else None
users = {r["user_id"]: r for r in csv.DictReader(open(DATA / "users.csv"))}
req = {r["user_id"]: r for r in csv.DictReader(open(DATA / "requests.csv"))}

def closed_by(u, n):  # closed within n days of join
    c = d(u["account_closed_ts"]); return c is not None and (c - d(u["joined_ts"])).days <= n
def eligible(u, n): return (SNAP - d(u["joined_ts"])).days >= n

def rate(rows, n):
    rows = [u for u in rows if eligible(u, n)]
    k = sum(closed_by(u, n) for u in rows)
    return len(rows), (1 - k / len(rows)) if rows else float("nan")

def diff(a, b, n):
    na, ra = rate(a, n); nb, rb = rate(b, n)
    se = math.sqrt(ra * (1 - ra) / na + rb * (1 - rb) / nb)
    return f"{ra:.2%} (n={na}) vs {rb:.2%} (n={nb})  diff {ra-rb:+.2%} ±{1.96*se:.2%}"

T = [u for u in users.values() if u["experiment_group"] == "treatment"]
C = [u for u in users.values() if u["experiment_group"] == "control"]
room = lambda u: (int(u["max_eligible_limit_cents"]) - int(u["starting_limit_cents"])) // 100
inc = lambda u: (int(req[u["user_id"]]["requested_limit_cents"]) - int(u["starting_limit_cents"])) // 100

print("== ITT retention, treatment vs control ==")
for n in (14, 30, 45, 60):
    print(f" {n}d:", diff(T, C, n))
print(" raw open at snapshot:", f"T {1-sum(bool(u['account_closed_ts']) for u in T)/len(T):.2%}  C {1-sum(bool(u['account_closed_ts']) for u in C)/len(C):.2%}")

print("\n== by room ($), treatment vs control, 30d retention (room is pre-randomization) ==")
for r in sorted({room(u) for u in users.values()}):
    print(f" room {r:>5}:", diff([u for u in T if room(u) == r], [u for u in C if room(u) == r], 30))

print("\n== treatment by outcome, 30d retention ==")
def outcome(u):
    q = req.get(u["user_id"]); return "no request" if not q else q["decision"] + (":" + q["decline_reason"] if q["decline_reason"] else "")
g = collections.defaultdict(list)
for u in T: g[outcome(u)].append(u)
for k, v in sorted(g.items()): print(f" {k:<45} n_all={len(v):>7}  30d n/ret={rate(v,30)}")
print(" control                                       ", rate(C, 30))

print("\n== decline: requested above ceiling? reason by room ==")
x = collections.Counter((room(u), req[u["user_id"]]["decline_reason"] or "APPROVED") for u in T if u["user_id"] in req)
for k in sorted(x): print(" ", k, x[k])

print("\n== requested increase vs room (treatment requesters) ==")
for r in sorted({room(u) for u in T}):
    rs = [u for u in T if u["user_id"] in req and room(u) == r]
    over = sum(inc(u) > r for u in rs)
    print(f" room {r:>5}: requesters {len(rs)} asked-over-room {over/len(rs):.1%}  median ask {sorted(inc(u) for u in rs)[len(rs)//2]}")

print("\n== $50 asks ==")
f = [u for u in T if u["user_id"] in req and inc(u) == 50]
print(" n", len(f), "decisions", collections.Counter(req[u["user_id"]]["decision"] for u in f),
      "rooms", collections.Counter(room(u) for u in f).most_common(6))
print(" dates", collections.Counter(req[u["user_id"]]["requested_ts"][:7] for u in f), "starting", collections.Counter(int(u["starting_limit_cents"])//100 for u in f))
print(" 30d ret", rate(f, 30))

print("\n== days from join to request; days from decline to close ==")
lag = collections.Counter(min((d(req[u['user_id']]['requested_ts']) - d(u['joined_ts'])).days, 30) for u in T if u['user_id'] in req)
print(" join->request days (cap 30):", sorted(lag.items())[:12])
dc = collections.Counter()
for u in T:
    q = req.get(u["user_id"])
    if q and u["account_closed_ts"]:
        dc[(q["decision"], min((d(u["account_closed_ts"]) - d(q["requested_ts"])).days, 30))] += 1
for dec in ("APPROVED", "DECLINED"):
    print(f" {dec} req->close days:", [(k[1], v) for k, v in sorted(dc.items()) if k[0] == dec][:15])
