# Sums what the measurement threads of a period cost, from their transcripts with helpers included.
#   python3 -I scripts/measure/spend.py --since 2026-10-19T09:00:00Z [--prefix measure]
# A thread counts when its title starts with the prefix. The group is the title without its arm,
# such as "measure judge" or "measure r101".
import argparse, collections, concurrent.futures as cf, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paired import bb, price_thread
from sources import when

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--since", required=True)
    a.add_argument("--prefix", default="measure")
    o = a.parse_args()
    since = when(o.since).timestamp() * 1000
    threads = {}
    for project in json.loads(bb("project", "list", "--json")):
        for flags in ([], ["--archived"]):
            for t in json.loads(bb("thread", "list", "--project", project["id"], *flags, "--json")):
                if (t.get("title") or "").startswith(o.prefix) and t["createdAt"] >= since:
                    threads[t["id"]] = t["title"]
    with cf.ThreadPoolExecutor(6) as ex:
        prices = dict(zip(threads, ex.map(lambda t: price_thread(t)["usd"], threads)))
    groups = collections.Counter()
    for t, title in threads.items():
        groups[" ".join(title.split()[:2])] += prices[t]
    for group, usd in sorted(groups.items()):
        print(f"{group:32} ${usd:.2f}")
    print(f"{len(threads)} threads, ${sum(prices.values()):.2f}")
    json.dump({t: {"title": threads[t], "usd": prices[t]} for t in threads}, sys.stderr)

if __name__ == "__main__":
    main()
