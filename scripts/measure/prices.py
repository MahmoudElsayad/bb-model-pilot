# Prices requests with the rates in routing/models.ts, so the scripts and the plugin share one table.
import os, re

MODELS_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "routing", "models.ts")
ENTRY = re.compile(r'"([\w.-]+)":\s*{[^}]*?rate:\s*{\s*input:\s*([\d.e-]+),\s*output:\s*([\d.e-]+),\s*cacheWrite:\s*([\d.e-]+),\s*cacheRead:\s*([\d.e-]+)', re.S)
RATES = {m: dict(zip(("input", "output", "cacheWrite", "cacheRead"), map(float, r))) for m, *r in ENTRY.findall(open(MODELS_TS).read())}
assert RATES, f"no rates found in {MODELS_TS}"

# Model ids that the table lacks, priced as the table entry of the same family and tier.
ALIAS = {
    "claude-sonnet-5": "claude-sonnet-5-5",
    "claude-opus-5": "claude-opus-5-5",
    "gpt-6-sol": "gpt-6.1-sol",
    "gpt-5.6-sol": "gpt-6.1-sol",
    "gpt-5.6-luna": "gpt-6-luna",
    "codex-auto-review": "gpt-6.1-sol",
}

def priced_as(model):
    m = ALIAS.get(model, model)
    return m if m in RATES else None

def usd(r, model=None):
    """Cost of one request by category. 5-minute cache writes cost 1.25x input, 1-hour writes the table's cacheWrite."""
    m = priced_as(model or r["model"])
    if m is None:
        return None
    p = RATES[m]
    return {
        "write": r["w5"] * p["input"] * 1.25 + r["w1h"] * p["cacheWrite"],
        "read": r["read"] * p["cacheRead"],
        "new": r["new"] * p["input"],
        "out": r["out"] * p["output"],
    }
