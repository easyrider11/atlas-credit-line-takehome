# Credit line increase take-home: submission

- **Decision and next experiment:** [`DECISIONS.pdf`](DECISIONS.pdf) (source: [`docs/DECISIONS.html`](docs/DECISIONS.html))
- **App:** React Native, in [`react_native_app/`](react_native_app/). The Flutter app is untouched.
- **Screens:** [`docs/screens/`](docs/screens/), one per state at phone width
- **Analysis scripts:** [`analysis/`](analysis/) (Python stdlib only)
- **AI transcripts:** [`transcripts/`](transcripts/)

## Run it

Needs Node 18+. Two terminals:

```bash
cd mock-api && npm start
```

```bash
cd react_native_app && npm install && npm run web
```

Open http://localhost:8081. At the bottom of Home there are two separate demo switches:
**PERSONA** (which member you are, from the mock API) and **GROUP** (the experiment group). GROUP only
offers the groups that apply to that member: revised flow or holdback for a member with room, A or B
for a member with none.
On web you can also link straight to a combination:

| What you see | Link |
|---|---|
| Room, revised flow (95%) | http://localhost:8081/?persona=utilization-too-high&group=flow |
| Room, holdback with no feature (5%) | http://localhost:8081/?persona=utilization-too-high&group=holdback |
| No room, A hidden (50%) | http://localhost:8081/?persona=insufficient-history&group=hidden |
| No room, B status card (50%) | http://localhost:8081/?persona=insufficient-history&group=status |

The mock API keeps state in memory and allows one request per persona. Restart it to reset.

## Allocation

Members are split by room at signup (ceiling minus starting limit), and each side has its own split:

| Members | Share of signups | Groups |
|---|---|---|
| Room > 0 | 77% | 95% revised request flow, with the slider capped at their room · 5% holdback with no increase feature |
| Room = 0 | 23% | 50% **A · hidden**: no entry point, what control saw · 50% **B · status**: a card on Home with the current limit, that no increase is available, and the specific reasons |

The holdback checks that the gain persists now that the flow has changed. It is separate from the
no-room experiment, and 5% is an operational choice, not an allocation sized from the analysis.

The demo's **GROUP** switch shows each of these four experiences; the holdback is the control
experience (no entry point). Assignment itself is not built; production would randomize at signup.

## Check it

```bash
cd react_native_app && npm run typecheck
```

```bash
cd mock-api && ./smoke.sh
```

`smoke.sh` needs a freshly started mock API. Journeys checked by hand in the running web app at
375×812: approval goes live and Home reloads; the slider stops at the member's room; a duplicate
submit (409) shows the decision already made, with reasons; each GROUP shows its experience (holdback
and A: no entry point; B: the status card; revised flow: the request button).

Lost responses were tested by wrapping `fetch` in the page so the POST reached the server but its
response was dropped. In every case "Check status" reads the account before allowing another submit:

| Case | Requests the app made | Result |
|---|---|---|
| Server decided, response lost | POST, GET | Shows the server's decision; no second POST |
| Request never reached the server | POST, GET, POST | Account has no request, so it allows a resubmit; approved |
| Response lost and account read fails | POST, GET (fails), GET | Stays "can't confirm" with no submit offered; shows the decision once the account loads |

Analysis (each script takes the data folder and runs in under a minute):

```bash
python3 analysis/retention.py data
```

`explore.py` checks data integrity; `retention.py`, `dose.py`, `deeper.py`, `nonrequesters.py` and
`verify.py` produce the cuts quoted in `DECISIONS.pdf`.

## Changes outside the app

- `mock-api/server.js`: `GET /v1/credit-line` also returns `increase_eligibility`
  (`{ eligible, reason_codes }`), set at signup like the ceiling. Arm B needs it to show the reasons
  without making the member submit a request that can only be declined. Approval rules are unchanged;
  `smoke.sh` passes 26/26. Documented in `mock-api/README.md`.

---

# Credit line increase take-home

- **Timebox:** Two hours
- **Tools:** Anything
- **Framework:** Pick either the Flutter base app (`flutter_app/`) or the React
  Native base app (`react_native_app/`)

## Context

Atlas serves people traditional banks often overlook. Members pay monthly for a
spending account, a card, and a credit line.

A higher limit can give someone more room to manage their money. A confusing or
dismissive experience can add stress when they need clarity. Treat this work with care.

## The experiment

For the last few weeks, some new members have been able to request a credit limit
increase in the app. The control group never sees an Increase button, and neither do
they actually get an increase.

When a member requests an increase, Atlas performs a soft inquiry. This does not hurt
their credit score.

The treatment experience is in `flutter_app/` or `react_native_app/`:

1. **Your credit line**
2. **Request an increase**, including an amount slider
3. **Decision**

It runs against `mock-api/`:

```bash
cd mock-api && npm start
```

Then, from `flutter_app/`:

```bash
flutter run
```

Or, from `react_native_app/`:

```bash
npm install
npm run web
```

You can also use `npm run ios` or `npm run android`.

The persona control on Home switches between the four outcomes the server can return.
See `mock-api/README.md` for details.

## The data

The experiment data is in `data/`. Join the two CSV files on `user_id`.

- Maximum eligible and initial limit is calculated once when the user joins and not
  re-evaluated after join. Maximum eligible limit should remain fixed in any proposal
  of yours.
- Assignment was randomized at signup with an approximately 50/50 split.
- Members joined from early June onward; snapshot taken 2026-08-25.

### `users.csv`: one row per member in the experiment window

| Column | Meaning |
|---|---|
| `user_id` | Identifier. Joins to `requests.csv` |
| `joined_ts` | The day they paid their first membership |
| `experiment_group` | `treatment` (could request an increase) or `control` |
| `account_closed_ts` | The day they closed their account. Blank if still open at the snapshot |
| `starting_limit_cents` | The member's credit limit when they joined |
| `max_eligible_limit_cents` | The member's maximum eligible limit at signup. Fixed for the experiment |

### `requests.csv`: one row per increase request

| Column | Meaning |
|---|---|
| `user_id` | Who asked |
| `decision` | `APPROVED` or `DECLINED` |
| `decline_reason` | Set on declines: `UTILIZATION_TOO_HIGH`, `INSUFFICIENT_PAYMENT_HISTORY`, or `NEW_CREDIT_LINES` |
| `requested_limit_cents` | The total credit limit the member requested, not the amount of the increase |
| `requested_ts` | When the member submitted the request |

## Deliverables

- A one-page `DECISIONS.pdf` covering:
  - your ship or no-ship decision (or something else) and the evidence and reasoning
    behind it
  - what the next experiment(s) you'd run would be
- Fully working UX and designs for your proposed next experiment's experiment groups
- Your full AI transcript, if you used AI tools

Prioritize by what's most impactful for improving member retention %.

## Constraints

- Two hours
- No authentication work

Make the right decisions and choose the scope correctly to finish well within the
timebox.

## Evaluation

| Weight | Axis |
|---:|---|
| **25%** | Reading the data |
| **35%** | Prioritization |
| **40%** | User experience |

## Follow-up

We will spend 30 minutes together extending what you built and discussing one decision
in depth.
