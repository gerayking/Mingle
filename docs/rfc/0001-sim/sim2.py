"""MING-134 round 3: closed-loop simulator for messy group chats.

Run: python3 sim2.py [seeds]   (default 60)

What changed from sim.py / sim_all.py:
- Closed loop: a person talking with the agent starts their next burst only after the agent
  answered (+ think time), so a slow agent also slows the conversation, like in real life.
- Messy timing: lognormal gaps inside a burst, 12% "stop to think" pauses of 15-45 s, long
  pauses (median 40 min) between sessions.
- Big groups: 30-50 people with Zipf activity talking among themselves, open loop, alongside
  the people talking with the agent. Floods of 30 lines/min.
- Several people can talk with the agent at once.
- Delivery uses the real 30-line cap (HEAR_MESSAGES, newest 30), so lines can be dropped.
"""
import heapq, math, random, statistics as st, sys

CAP = 30           # HEAR_MESSAGES
HALF = 120.0       # E half-life (s)

# ---------------------------------------------------------------- scenario generation
def lognorm(rng, median, sigma):
    return median * math.exp(rng.gauss(0, sigma))

def burst_gaps(rng, n, slow=False):
    gaps = []
    for _ in range(n - 1):
        if rng.random() < (0.25 if slow else 0.12):
            gaps.append(rng.uniform(15, 45))             # stops to think mid-turn
        else:
            gaps.append(min(lognorm(rng, 4.5, 0.6), 25))
    return gaps

def burst_len(rng):
    return rng.choice([1, 1, 1, 2, 2, 3, 3, 4, 5, 7])

class Peer:
    """Someone who talks with the agent: sessions of several exchanges, long pauses between."""
    def __init__(s, name, rng, first_at, exchanges=(4, 10), pause=2400, slow=False, name_p=0.5):
        s.name, s.rng, s.slow, s.name_p = name, rng, slow, name_p
        s.exchanges, s.pause = exchanges, pause
        s.left = rng.randint(*exchanges); s.first = True; s.start = first_at

    def burst(s, t0):
        n = burst_len(s.rng); t = t0; out = []
        gaps = burst_gaps(s.rng, n, s.slow)
        for k in range(n):
            if k: t += gaps[k - 1]
            out.append(dict(t=t, who=s.name, agent=True, last=(k == n - 1),
                            name=(s.first and k == 0 and s.rng.random() < s.name_p), cold=s.first))
        s.first = False
        return out

    def next_start(s, answered_at):
        s.left -= 1
        if s.left > 0:
            return answered_at + lognorm(s.rng, 12, 0.7)       # reads the answer, types back
        s.left = s.rng.randint(*s.exchanges); s.first = True
        return answered_at + lognorm(s.rng, s.pause, 0.8)      # session over: long pause

def chatter(rng, people, per_min, horizon, active=None):
    """Open-loop chatter among `people` persons with Zipf activity (bursts of 1-3)."""
    w = [1 / (i + 1) for i in range(people)]
    out = []; t = 0.0
    while t < horizon:
        t += rng.expovariate(per_min / 60 / 1.6)
        if active and not active(t): continue
        who = "p%d" % rng.choices(range(people), w)[0]
        n = rng.choice([1, 1, 2, 3]); tt = t
        for k, g in enumerate([0] + burst_gaps(rng, n)):
            tt += g
            out.append(dict(t=tt, who=who, agent=False, last=(k == n - 1), name=False))
    return [m for m in out if m["t"] < horizon]

SCENARIOS = {
    # name: (horizon s, peers factory, chatter factory)
    "duet, long pauses": (6 * 3600,
        lambda r: [Peer("bryce", r, 5)], lambda r, h: []),
    "duet, slow typist": (3 * 3600,
        lambda r: [Peer("bryce", r, 5, slow=True, pause=900)], lambda r, h: []),
    "30 ppl, 6/min + 1 peer": (2 * 3600,
        lambda r: [Peer("bryce", r, 30, pause=900)], lambda r, h: chatter(r, 30, 6, h)),
    "50 ppl, 30/min flood + 1 peer": (3600,
        lambda r: [Peer("bryce", r, 30, pause=600)], lambda r, h: chatter(r, 50, 30, h)),
    "12 ppl, 3 peers + 3/min": (2 * 3600,
        lambda r: [Peer("a", r, 10, pause=1200), Peer("b", r, 200, pause=1200), Peer("c", r, 400, pause=1200)],
        lambda r, h: chatter(r, 12, 3, h)),
    "40 ppl, nobody for agent, 24h": (24 * 3600,
        lambda r: [], lambda r, h: chatter(r, 40, 4, h, active=lambda t: (t % 86400) / 3600 < 14)),
}

# ---------------------------------------------------------------- algorithms
class V1:
    merge = False; prio = False; pending_engaged = False
    def __init__(s): s.q, s.mw, s.g = 20, 60, 120; s.last_hear = -1e9; s.unans = 0
    def params(s, now, m):
        g = s.g if s.unans < 3 else min(s.g * 2 ** (s.unans - 2), 1800)
        return s.q, s.mw, g
    def on_msg(s, m): pass
    def on_hear(s, now, spoke, to): s.last_hear = now; s.unans = 0 if spoke else s.unans + 1

class Gaps:
    """Per-person rhythm: gaps < 30 s between one person's lines, last 20."""
    def __init__(s): s.gaps = {}; s.prev = {}
    def add(s, m):
        p = s.prev.get(m["who"])
        if p is not None and m["t"] - p < 30: s.gaps.setdefault(m["who"], []).append(m["t"] - p)
        s.prev[m["who"]] = m["t"]
    def turn_end(s, who, k=2.0, lo=3, hi=12, default=8):
        g = s.gaps.get(who, [])[-20:]
        if len(g) < 3: return default
        return min(max(st.mean(g) + k * st.pstdev(g), lo), hi)

class V21(V1):  # DIYGod V2.1 as posted
    def __init__(s): super().__init__(); s.spoke = -1e9; s.silent = 0; s.ew = {}; s.prev = {}
    def hot(s, now): return now - s.spoke < 180 and s.silent < 2
    def on_msg(s, m):
        p = s.prev.get(m["who"])
        if p is not None and m["t"] - p < 20: s.ew[m["who"]] = 0.7 * s.ew.get(m["who"], 8) + 0.3 * (m["t"] - p)
        s.prev[m["who"]] = m["t"]
    def params(s, now, m):
        if s.hot(now): return min(15, max(4, 1.6 * s.ew.get(m["who"], 8))), 30, 0
        return super().params(now, m)
    def on_hear(s, now, spoke, to):
        hot = s.hot(now); super().on_hear(now, spoke, to)
        if spoke: s.spoke = now; s.silent = 0
        elif hot: s.silent += 1

class E(V1):  # Mingle's E, as posted (single peer, chat-wide clock), no insertion
    def __init__(s): super().__init__(); s.E = 0; s.tE = 0; s.peer = None; s.g2 = Gaps(); s.tok = 4; s.tt = 0
    def e(s, now): return s.E * 0.5 ** ((now - s.tE) / HALF)
    def on_msg(s, m):
        s.g2.add(m)
        if m["name"]: s.E = max(s.e(m["t"]), 0.8); s.tE = m["t"]
    def params(s, now, m):
        s.tok = min(4, s.tok + (now - s.tt) / 600); s.tt = now
        e = s.e(now) * (1 if m["who"] == s.peer else 0.5)
        if s.tok < 1 or e < 0.05: return super().params(now, m)
        return s.g2.turn_end(m["who"]) * e + 20 * (1 - e), 15 * e + 60 * (1 - e), 120 * (1 - e) ** 2
    def on_hear(s, now, spoke, to):
        super().on_hear(now, spoke, to)
        if spoke: s.E = 1; s.tE = now; s.peer = to[0] if to else s.peer
        else: s.E = s.e(now) * 0.6; s.tE = now; s.tok -= 1

class V3(V1):
    """Proposal: per-person engagement; only engaged lines move the clock; merge while busy;
    engaged lines are never cut by the 30-line cap; waste bucket."""
    merge = True; prio = True
    def __init__(s, half=HALF, damp=0.6, k=2.0, hi=12, maxwait=15, engaged=0.25, bucket=(4, 600)):
        super().__init__(); s.Ep = {}; s.g2 = Gaps(); s.half, s.damp, s.k, s.hi = half, damp, k, hi
        s.maxwait, s.th = maxwait, engaged; s.cap, s.refill = bucket; s.tok = s.cap; s.tt = 0
    def e(s, who, now):
        E, t = s.Ep.get(who, (0, 0)); return E * 0.5 ** ((now - t) / s.half)
    def engaged(s, m): return s.tok >= 1 and (m["name"] or s.e(m["who"], m["t"]) >= s.th)
    pending_engaged = False
    def on_msg(s, m):
        s.g2.add(m)
        if m["name"]: s.Ep[m["who"]] = (max(s.e(m["who"], m["t"]), 0.8), m["t"])
    def params(s, now, m):
        s.tok = min(s.cap, s.tok + (now - s.tt) / s.refill); s.tt = now
        if s.engaged(m):
            e = max(s.e(m["who"], now), 0.8 if m["name"] else 0)
            q = s.g2.turn_end(m["who"], s.k, 3, s.hi) * e + 20 * (1 - e)
            return q, s.maxwait * e + 60 * (1 - e), 0
        return super().params(now, m)
    def on_hear(s, now, spoke, to, heard=()):
        super().on_hear(now, spoke, to)
        if spoke:
            for w in to: s.Ep[w] = (1.0, now)
        else:
            s.tok -= 1
            for w in heard: s.Ep[w] = (s.e(w, now) * s.damp, now)

# ---------------------------------------------------------------- event simulation
def simulate(algo, scen, seed):
    horizon, peers_f, chat_f = SCENARIOS[scen]
    rng = random.Random(seed); arng = random.Random(seed * 7 + 1)
    peers = {p.name: p for p in peers_f(rng)}
    ev = []; seq = 0
    def push(t, kind, data=None):
        nonlocal seq; seq += 1; heapq.heappush(ev, (t, seq, kind, data))
    for m in chat_f(rng, horizon): push(m["t"], "msg", m)
    burst_id = 0
    def start_burst(p, t):
        nonlocal burst_id
        if t > horizon: return
        burst_id += 1
        for m in p.burst(t): m["b"] = burst_id; push(m["t"], "msg", m)
    for p in peers.values(): start_burst(p, p.start)

    pend = []; since = None; due_v = 0; busy_until = 0; fired = False; queue = []
    answered = set(); done_at = {}; open_lines = {}
    R = dict(rounds=0, wasted=0, premature=0, lat=[], lines=[], dropped=0, late=0, bursts=0)

    def deliver(now, batch):
        nonlocal busy_until
        R["rounds"] += 1
        if len(batch) > CAP:
            if algo.prio:
                keep = [m for m in batch if m.get("eng")]
                rest = [m for m in batch if not m.get("eng")]
                keep = keep[-CAP:]; batch2 = keep + rest[-(CAP - len(keep)):] if len(keep) < CAP else keep
            else:
                batch2 = batch[-CAP:]
            R["dropped"] += sum(1 for m in batch if m["agent"] and m not in batch2)
            batch = batch2
        R["lines"].append(len(batch))
        end = now + arng.uniform(20, 45)
        busy_until = end
        mine = [m for m in batch if m["agent"] and m["b"] not in answered]
        complete = {m["b"]: m for m in mine if m["last"]}
        to = []
        if complete:
            spoke = True
            for b, m in complete.items():
                answered.add(b); to.append(m["who"])
                R["lat"].append(end - m["t"])
                R.setdefault("cold" if m.get("cold") else "warm", []).append(end - m["t"])
                if end - m["t"] > 120: R["late"] += 1
                push(end, "answered", m["who"])
        elif mine and arng.random() < 0.5:
            spoke = True; R["premature"] += 1; to = [mine[-1]["who"]]
        else:
            spoke = False; R["wasted"] += 1
        heard = sorted({m["who"] for m in batch})
        if isinstance(algo, V3b): algo.on_hear(now, spoke, to, heard, fast=any(m.get("eng") for m in batch))
        elif isinstance(algo, V3): algo.on_hear(now, spoke, to, heard)
        else: algo.on_hear(now, spoke, to)
        push(end, "free")

    while ev:
        t, _, kind, data = heapq.heappop(ev)
        if t > horizon + 3600: break
        if kind == "msg":
            m = data
            if m["agent"] and m["last"]: R["bursts"] += 1
            algo.on_msg(m)
            if isinstance(algo, V3):
                m["eng"] = algo.engaged(m)
            pend.append(m)
            if since is None: since = t
            if fired and algo.merge: continue          # already due; waits for the round to end
            if isinstance(algo, V3):
                if m["eng"]:
                    if not algo.pending_engaged: since = t; algo.pending_engaged = True
                elif algo.pending_engaged: continue    # rides along, does not move the clock
            q, mw, g = algo.params(t, m)
            due = max(min(t + q, since + mw), algo.last_hear + g)
            due_v += 1; push(due, "due", due_v)
        elif kind == "due":
            if data != due_v or not pend: continue
            if algo.merge:
                if t < busy_until: fired = True; continue
                batch, pend, since = pend, [], None
                if isinstance(algo, V3): algo.pending_engaged = False
                deliver(t, batch)
            else:
                batch, pend, since = pend, [], None
                if t < busy_until: queue.append(batch)
                else: deliver(t, batch)
        elif kind == "free":
            if t < busy_until: continue
            if algo.merge and fired:
                fired = False
                if pend:
                    batch, pend, since = pend, [], None
                    algo.pending_engaged = False
                    deliver(t, batch)
            elif queue:
                deliver(t, queue.pop(0))
        elif kind == "answered":
            p = peers[data]; start_burst(p, p.next_start(t))
    return R

ALGOS = {
    "V1": V1, "V2.1": V21, "E": E, "V3": V3,
}

def summarize(algo_f, scen, seeds):
    acc = dict(rounds=0, wasted=0, premature=0, dropped=0, late=0, bursts=0); L = []; lines = []
    for sd in range(seeds):
        R = simulate(algo_f(), scen, sd)
        for k in acc: acc[k] += R[k]
        L += R["lat"]; lines += R["lines"]
    hrs = SCENARIOS[scen][0] / 3600
    p = lambda q: sorted(L)[int(len(L) * q)] if L else float("nan")
    return dict(
        rph=acc["rounds"] / seeds / hrs, wph=acc["wasted"] / seeds / hrs, pre=acc["premature"] / seeds / hrs,
        p50=p(.5), p90=p(.9), late=100 * acc["late"] / max(1, len(L)),
        drop=acc["dropped"] / seeds, lines=st.mean(lines) if lines else 0, bursts=acc["bursts"] / seeds / hrs)

class V3b(V3):
    """V3 + (a) only a silent *fast* batch costs a token; chatter is already paced by V1's gap and
    backoff. (b) While someone is in a live conversation with the agent, other lines do not get a
    turn of their own: they ride along with the next engaged batch (or wait until it goes cold)."""
    def live(s, now): return s.tok >= 1 and any(s.e(w, now) >= s.th for w in s.Ep)
    def on_hear(s, now, spoke, to, heard=(), fast=False):
        V1.on_hear(s, now, spoke, to)
        if spoke:
            for w in to: s.Ep[w] = (1.0, now)
        else:
            if fast: s.tok -= 1
            for w in heard: s.Ep[w] = (s.e(w, now) * s.damp, now)
    def params(s, now, m):
        r = super().params(now, m)
        if not s.engaged(m) and s.live(now):
            return r[0], r[1], max(r[2], 240)      # hold chatter while a conversation is live
        return r

ALGOS["V3b"] = V3b

if __name__ == "__main__":
    seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    print(f"{'scenario':32} {'algo':5} {'turns/h':>7} {'wasted/h':>8} {'cut-in/h':>8} {'p50':>5} {'p90':>5} {'>2min%':>6} {'peer lines dropped':>18} {'lines/turn':>10}")
    for scen in SCENARIOS:
        for name, f in ALGOS.items():
            r = summarize(f, scen, seeds)
            print(f"{scen:32} {name:5} {r['rph']:7.1f} {r['wph']:8.1f} {r['pre']:8.1f} {r['p50']:5.0f} {r['p90']:5.0f} {r['late']:6.1f} {r['drop']:18.2f} {r['lines']:10.1f}")
        print()
