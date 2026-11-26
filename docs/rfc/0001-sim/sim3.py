"""MING-134 round 4 (Mingle): counterexamples for V3b and a fix, V3c. Needs sim2.py next to it.

Run: python3 sim3.py [seeds]   (default 30)

New scenarios:
- "name spammer": someone says the agent's name in every line as a running joke and never wants it.
  In V3b every such line is fast lane; the shared bucket drains and the real peer drops to V1.
- "hijack": a person the agent answered once floods for 4 min (E=1 lets every line move the clock
  and holds everyone else's chatter).
- Content cues for cold start: a peer's first line carries a cue (question to "you", follows the
  agent's last message, ...) with p=0.7; chatter carries a false cue with p=0.03 (0.10 in "noisy").

V3c = V3b +
  (1) per-person bucket (3, +1/10 min) under a group bucket (8, +1/5 min): one person cannot spend
      the group's budget; a silent fast batch debits the people who made it fast.
  (2) a name or cue that went unanswered is worth less next time: boost * 0.5^ignored.
  (3) cue boost E >= 0.5 (weaker than a name's 0.8), so cold first lines from a real peer go fast.
"""
import random, statistics as st, sys
import sim2
from sim2 import *

# ---------------------------------------------------------------- cues
def with_cues(scen_f, chat_f, p_peer=0.7, p_noise=0.03):
    def peers(r):
        ps = scen_f(r)
        for p in ps:
            orig = p.burst
            def burst(t0, p=p, orig=orig):
                out = orig(t0)
                for k, m in enumerate(out):
                    m["cue"] = m.get("cold") and k == 0 and not m["name"] and p.rng.random() < p_peer
                return out
            p.burst = burst
        return ps
    def chat(r, h):
        out = chat_f(r, h)
        for m in out: m["cue"] = r.random() < p_noise
        return out
    return peers, chat

def spammer(rng, h, who="joker", per_min=1.0):
    out = []; t = 60.0
    while t < h:
        t += rng.expovariate(per_min / 60)
        out.append(dict(t=t, who=who, agent=False, last=True, name=True, cue=False))
    return out

def hijacker(rng, h):
    # 'x' calls the agent by name once, then floods 4 min of lines that are not for it
    out = []
    for start in range(1200, int(h), 1800):
        t = float(start); first = True
        while t < start + 240:
            t += rng.uniform(3, 8)
            out.append(dict(t=t, who="x", agent=False, last=True, name=first, cue=False)); first = False
    return out

base = dict(sim2.SCENARIOS)
NEW = {}
for name in ["duet, long pauses", "30 ppl, 6/min + 1 peer", "12 ppl, 3 peers + 3/min", "50 ppl, 30/min flood + 1 peer"]:
    h, pf, cf = base[name]
    NEW[name] = (h, *with_cues(pf, cf))
h, pf, cf = base["30 ppl, 6/min + 1 peer"]
NEW["30 ppl + noisy cues (10%)"] = (h, *with_cues(pf, cf, p_noise=0.10))
NEW["12 ppl, 1 peer + name spammer"] = (2 * 3600, *with_cues(
    lambda r: [Peer("bryce", r, 30, pause=900)],
    lambda r, hh: chatter(r, 12, 3, hh) + spammer(r, hh)))
NEW["12 ppl, 1 peer + hijacker"] = (2 * 3600, *with_cues(
    lambda r: [Peer("bryce", r, 30, pause=900)],
    lambda r, hh: chatter(r, 12, 3, hh) + hijacker(r, hh)))
h, pf, cf = base["40 ppl, nobody for agent, 24h"]
NEW["40 ppl, nobody for agent, 24h"] = (h, *with_cues(pf, cf))
sim2.SCENARIOS.clear(); sim2.SCENARIOS.update(NEW)

# ---------------------------------------------------------------- V3c
class V3c(V3b):
    NAME, CUE = 0.8, 0.5
    def __init__(s, person=(3, 600), group=(8, 300), **kw):
        super().__init__(bucket=group, **kw)
        s.pcap, s.prefill = person; s.ptok = {}; s.ignored = {}
    def ptoken(s, who, now):
        tok, t = s.ptok.get(who, (s.pcap, now))
        tok = min(s.pcap, tok + (now - t) / s.prefill); s.ptok[who] = (tok, now); return tok
    def boost(s, m):
        b = s.NAME if m["name"] else s.CUE if m.get("cue") else 0
        return b * 0.5 ** s.ignored.get(m["who"], 0)
    def engaged(s, m):
        if s.tok < 1 or s.ptoken(m["who"], m["t"]) < 1: return False
        return max(s.e(m["who"], m["t"]), s.boost(m)) >= s.th
    def on_msg(s, m):
        s.g2.add(m)
        b = s.boost(m)
        if b: s.Ep[m["who"]] = (max(s.e(m["who"], m["t"]), b), m["t"])
    def params(s, now, m):
        s.tok = min(s.cap, s.tok + (now - s.tt) / s.refill); s.tt = now
        if s.engaged(m):
            e = max(s.e(m["who"], now), s.boost(m))
            q = s.g2.turn_end(m["who"], s.k, 3, s.hi) * e + 20 * (1 - e)
            return q, s.maxwait * e + 60 * (1 - e), 0
        r = V1.params(s, now, m)
        return (r[0], r[1], max(r[2], 240)) if s.live(now) else r
    def on_hear(s, now, spoke, to, heard=(), fast=False, eng=()):
        V1.on_hear(s, now, spoke, to)
        if spoke:
            for w in to: s.Ep[w] = (1.0, now); s.ignored[w] = 0
        else:
            if fast: s.tok -= 1
            for w in eng:
                tok, t = s.ptok.get(w, (s.pcap, now)); s.ptok[w] = (tok - 1, t)
                s.ignored[w] = s.ignored.get(w, 0) + 1
            for w in heard: s.Ep[w] = (s.e(w, now) * s.damp, now)


# ---------------------------------------------------------------- V3d
class V3d(V3c):
    """V3c, but how much a name or a cue is worth is learned, not fixed: a Beta(1,1) posterior of
    P(agent spoke | the batch was made fast by this signal), per person for names, per group for cues,
    with counts fading toward the prior (half-life 1 h). boost = base * posterior mean.
    Group bucket back to V3b's (4, +1/10 min); per person (2, +1/15 min)."""
    def __init__(s, person=(2, 900), group=(4, 600), fade=3600, **kw):
        super().__init__(person=person, group=group, **kw); s.fade = fade; s.beta = {}; s.sig = {}
    def post(s, key, now):
        a, b, t = s.beta.get(key, (0.0, 0.0, now)); f = 0.5 ** ((now - t) / s.fade)
        s.beta[key] = (a * f, b * f, now); a, b, _ = s.beta[key]; return (a + 1) / (a + b + 2)
    def key(s, m): return ("name", m["who"]) if m["name"] else ("cue",) if m.get("cue") else None
    def boost(s, m):
        k = s.key(m)
        if not k: return 0
        return (s.NAME if m["name"] else s.CUE * 1.6) * s.post(k, m["t"])   # cue starts at 0.4, name at 0.4
    def engaged(s, m):
        if s.tok < 1 or s.ptoken(m["who"], m["t"]) < 1: return False
        k = s.key(m)
        if k and s.e(m["who"], m["t"]) < s.th and s.boost(m) >= s.th: s.sig[k] = 1  # this signal made it fast
        return max(s.e(m["who"], m["t"]), s.boost(m)) >= s.th
    def on_hear(s, now, spoke, to, heard=(), fast=False, eng=()):
        for k in s.sig:
            s.post(k, now); a, b, t = s.beta[k]; s.beta[k] = (a + spoke, b + (not spoke), t)
        s.sig = {}
        V1.on_hear(s, now, spoke, to)
        if spoke:
            for w in to: s.Ep[w] = (1.0, now)
        else:
            if fast: s.tok -= 1
            for w in eng:
                tok, t = s.ptok.get(w, (s.pcap, now)); s.ptok[w] = (tok - 1, t)
            for w in heard: s.Ep[w] = (s.e(w, now) * s.damp, now)

# patch delivery hook so V3c learns who made the batch fast
_orig_sim = sim2.simulate
def simulate(algo, scen, seed):
    if isinstance(algo, V3c):
        orig = algo.on_hear
        def hook(now, spoke, to, heard=(), fast=False):
            return orig(now, spoke, to, heard, fast, eng=algo._eng_in_batch)
        algo.on_hear = hook; algo._eng_in_batch = set()
        o_engaged = algo.engaged
    return _orig_sim(algo, scen, seed)
sim2.simulate = simulate


# ---------------------------------------------------------------- V3e
class V3e(V3c):
    """V3c, with the cue's weight corrected for base rate: the busier the group, the more lines carry a
    cue by chance, so P(addressed | cue) falls roughly as 1/rate. cue boost = 0.5 * min(1, 6/min / rate),
    rate = lines/min over the last 5 min. Names are not scaled: they are rare by chance."""
    def __init__(s, r0=6.0, **kw): super().__init__(**kw); s.r0 = r0; s.recent = []
    def on_msg(s, m):
        s.recent.append(m["t"]); s.recent = [t for t in s.recent if t > m["t"] - 300]
        super().on_msg(m)
    def boost(s, m):
        b = super().boost(m)
        if m.get("cue") and not m["name"]:
            rate = len(s.recent) / 5
            b *= min(1.0, s.r0 / max(rate, 1e-9))
        return b

# track engaged senders per pending batch, reset on delivery
def track(cls):
    _e, _oh = cls.engaged, cls.on_hear
    def engaged(s, m):
        r = _e(s, m)
        if r and hasattr(s, "_eng_in_batch"): s._eng_in_batch.add(m["who"])
        return r
    def on_hear(s, *a, **k):
        _oh(s, *a, **k); s._eng_in_batch = set()
    cls.engaged, cls.on_hear = engaged, on_hear
track(V3c); track(V3d); track(V3e)

def summarize(f, scen, seeds):
    acc = dict(rounds=0, wasted=0, premature=0, dropped=0); L = []; C = []; answers = 0
    for sd in range(seeds):
        R = sim2.simulate(f(), scen, sd)
        for k in acc: acc[k] += R[k]
        L += R["lat"]; C += R.get("cold", [])
    hrs = sim2.SCENARIOS[scen][0] / 3600
    p = lambda X, q: sorted(X)[int(len(X) * q)] if X else float("nan")
    n = max(1, len(L))
    return dict(rpa=acc["rounds"] / n if L else float("nan"), wph=(acc["wasted"] + acc["premature"]) / seeds / hrs,
                p50=p(L, .5), p90=p(L, .9), late=100 * sum(x > 120 for x in L) / n, cold90=p(C, .9),
                drop=acc["dropped"] / seeds)

if __name__ == "__main__":
    seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    algos = {"V1": V1, "V3b": V3b, "V3c": V3c, "V3e": V3e}
    print(f"{'scenario':34} {'algo':4} {'rounds/answer':>13} {'waste+cut/h':>11} {'p50':>4} {'p90':>4} {'>2m%':>5} {'cold p90':>8} {'dropped':>7}")
    for scen in sim2.SCENARIOS:
        for name, f in algos.items():
            r = summarize(f, scen, seeds)
            print(f"{scen:34} {name:4} {r['rpa']:13.2f} {r['wph']:11.1f} {r['p50']:4.0f} {r['p90']:4.0f} {r['late']:5.1f} {r['cold90']:8.0f} {r['drop']:7.1f}")
        print()
