"""Are treatment non-requesters a selected group (closed before they got to ask)?"""
import csv, sys, collections, datetime as dt
from pathlib import Path
DATA = Path(sys.argv[1])
d = lambda s: dt.date.fromisoformat(s[:10]) if s else None
users = {r["user_id"]: r for r in csv.DictReader(open(DATA / "users.csv"))}
req = {r["user_id"]: r for r in csv.DictReader(open(DATA / "requests.csv"))}
room = lambda u: (int(u["max_eligible_limit_cents"]) - int(u["starting_limit_cents"])) // 100
for label, f in (("room=0", lambda u: room(u) == 0), ("room>0", lambda u: room(u) > 0)):
    nr = [u for u in users.values() if u["experiment_group"] == "treatment" and f(u) and u["user_id"] not in req]
    closed = [u for u in nr if u["account_closed_ts"]]
    lag = collections.Counter(min((d(u["account_closed_ts"]) - d(u["joined_ts"])).days, 15) for u in closed)
    print(f"{label} non-requesters n={len(nr)} closed={len(closed)} ({len(closed)/len(nr):.0%}); tenure-at-close days:", sorted(lag.items()))
