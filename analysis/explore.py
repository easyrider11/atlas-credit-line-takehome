"""First pass: data integrity checks + headline numbers. Stdlib only."""
import csv, sys, collections, datetime as dt, math
from pathlib import Path

DATA = Path(sys.argv[1])
SNAP = dt.date(2026, 8, 25)
d = lambda s: dt.date.fromisoformat(s[:10]) if s else None

users = {}
dupe_users = 0
with open(DATA / "users.csv") as f:
    for r in csv.DictReader(f):
        if r["user_id"] in users: dupe_users += 1
        users[r["user_id"]] = r
reqs = collections.defaultdict(list)
nreq = 0
with open(DATA / "requests.csv") as f:
    for r in csv.DictReader(f):
        reqs[r["user_id"]].append(r); nreq += 1

print("users", len(users), "dupe user rows", dupe_users, "requests", nreq, "requesters", len(reqs))
print("groups", collections.Counter(u["experiment_group"] for u in users.values()))
print("orphan requests (no user row)", sum(1 for k in reqs if k not in users))
print("requests by group of requester", collections.Counter(users[k]["experiment_group"] for k in reqs if k in users))
print("requests per user", collections.Counter(len(v) for v in reqs.values()))

jd = [d(u["joined_ts"]) for u in users.values()]
print("joined range", min(jd), max(jd))
cl = [d(u["account_closed_ts"]) for u in users.values() if u["account_closed_ts"]]
print("closed n", len(cl), "range", min(cl), max(cl))
print("closed before joined", sum(1 for u in users.values() if u["account_closed_ts"] and d(u["account_closed_ts"]) < d(u["joined_ts"])))
print("closed after snapshot", sum(1 for c in cl if c > SNAP))
print("start>max", sum(1 for u in users.values() if int(u["starting_limit_cents"]) > int(u["max_eligible_limit_cents"])))
room = collections.Counter((int(u["max_eligible_limit_cents"]) - int(u["starting_limit_cents"])) // 100 for u in users.values())
print("room $ top", sorted(room.items())[:15], "... zero-room share", room[0] / len(users))
print("starting limits", sorted(collections.Counter(int(u["starting_limit_cents"]) // 100 for u in users.values()).items()))

# request-level checks
bad = collections.Counter()
for uid, rs in reqs.items():
    u = users.get(uid)
    if not u: continue
    for r in rs:
        rl = int(r["requested_limit_cents"]); st = int(u["starting_limit_cents"]); mx = int(u["max_eligible_limit_cents"])
        inc = rl - st
        rt = d(r["requested_ts"])
        if rt < d(u["joined_ts"]): bad["req before join"] += 1
        if u["account_closed_ts"] and rt > d(u["account_closed_ts"]): bad["req after close"] += 1
        if rt > SNAP: bad["req after snapshot"] += 1
        if inc <= 0: bad["requested <= starting"] += 1
        if inc % 5000 or inc < 10000 or inc > 250000: bad["increase off-grid/out of bounds"] += 1
        if r["decision"] == "APPROVED" and rl > mx: bad["approved but over ceiling"] += 1
        if r["decision"] == "DECLINED" and rl <= mx: bad["declined but within ceiling"] += 1
        if r["decision"] == "DECLINED" and not r["decline_reason"]: bad["declined w/o reason"] += 1
        if r["decision"] == "APPROVED" and r["decline_reason"]: bad["approved with reason"] += 1
        if r["decision"] not in ("APPROVED", "DECLINED"): bad["weird decision " + r["decision"]] += 1
print("request anomalies", dict(bad))
allr = [r for rs in reqs.values() for r in rs]
print("decisions", collections.Counter(r["decision"] for r in allr))
print("reasons", collections.Counter(r["decline_reason"] for r in allr if r["decision"] == "DECLINED"))
incs = collections.Counter((int(r["requested_limit_cents"]) - int(users[r["user_id"]]["starting_limit_cents"])) // 100 for r in allr if r["user_id"] in users)
print("top requested increases $", incs.most_common(12))
