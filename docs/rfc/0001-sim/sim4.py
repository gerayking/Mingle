"""MING-134 round 5 (DIYGod): checks on Mingle's V3e. Needs sim2.py + sim3.py next to it.
Run: python3 sim4.py [seeds]

V3e-nc : V3e without content cues (isolates the anti-spam fixes)
V3f    : V3e-nc + "live" only counts people who can still go fast (own tokens >= 1, not ignored twice),
         so a hijacker who has burned their bucket no longer holds everyone else's lines.
V3g    : V3f + Mingle's rate-scaled content cue.
+X     : cross-talk fix: deadline = max over engaged senders in the pending batch of (their last line +
         their own turn-end window), still capped by max wait.
"""
import sys
import sim2, sim3
from sim2 import Peer, chatter
from sim3 import V3e, with_cues, summarize, track

class V3eNC(V3e):
    CUE = 0.0

class V3f(V3eNC):
    def live(s, now):
        if s.tok < 1: return False
        for w in s.Ep:
            if s.e(w, now) < s.th: continue
            tok, t = s.ptok.get(w, (s.pcap, now))
            if min(s.pcap, tok + (now - t) / s.prefill) >= 1 and s.ignored.get(w, 0) < 2: return True
        return False

class V3g(V3f):
    CUE = 0.5

def crossfix(cls):
    class X(cls):
        def __init__(s, **kw): super().__init__(**kw); s.lastq = {}
        def params(s, now, m):
            q, mw, g = super().params(now, m)
            if g == 0 and s.engaged(m):
                s.lastq[m["who"]] = now + q
                q = max(s.lastq.values()) - now
            return q, mw, g
        def on_hear(s, *a, **k):
            super().on_hear(*a, **k); s.lastq = {}
    X.__name__ = cls.__name__ + "X"
    return X

for c in (V3eNC, V3f, V3g): track(c)
V3eX = crossfix(V3e); V3gX = crossfix(V3g)

S = sim2.SCENARIOS
S["2 peers cross-talk"] = (3 * 3600, *with_cues(
    lambda r: [Peer("a", r, 5, pause=300), Peer("b", r, 9, pause=300)], lambda r, h: []))
S["2 peers cross-talk, slow + 3/min"] = (3 * 3600, *with_cues(
    lambda r: [Peer("a", r, 5, pause=300, slow=True), Peer("b", r, 9, pause=300, slow=True)],
    lambda r, h: chatter(r, 12, 3, h)))
S["30 ppl, 6/min, group bucket 4/10m"] = S["30 ppl, 6/min + 1 peer"]

if __name__ == "__main__":
    seeds = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    algos = {"V1": sim2.V1, "V3b": sim2.V3b, "V3e": V3e, "V3e-nc": V3eNC, "V3f": V3f, "V3g": V3g,
             "V3eX": V3eX, "V3gX": V3gX}
    small = {"V3e": lambda: V3e(group=(4, 600)), "V3f": lambda: V3f(group=(4, 600)), "V3g": lambda: V3g(group=(4, 600))}
    print(f"{'scenario':34} {'algo':6} {'rnd/ans':>7} {'waste/h':>7} {'p50':>4} {'p90':>4} {'>2m%':>5} {'cold90':>6} {'drop':>5}")
    for scen in S:
        A = small if "bucket 4/10m" in scen else algos
        for name, f in A.items():
            r = summarize(f, scen, seeds)
            print(f"{scen:34} {name:6} {r['rpa']:7.2f} {r['wph']:7.1f} {r['p50']:4.0f} {r['p90']:4.0f} {r['late']:5.1f} {r['cold90']:6.0f} {r['drop']:5.1f}")
        print()
