#!/usr/bin/env python3
"""Fetch PowFi stake events, combine deposits by recipient, and export a chart.

Requires matplotlib: python3 -m pip install matplotlib
Run: python3 misc/scripts/staking-distribution.py
"""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

VAULT = "225WevmFp5ZgzPsyVJTvyp2v2uyKrvp329HfrVmzffnWj"
NODE = "https://node.mainnet.alephium.org"
ATTO = 10**18
THRESHOLDS = [0, 100, 1_000, 10_000, 100_000, 1_000_000]
RANGES = ["Under 100", "100–<1,000", "1,000–<10,000", "10,000–<100,000", "100,000–<1 million", "1 million or more"]


def get_json(url):
    for attempt in range(3):
        try:
            request = Request(url, headers={"Accept": "application/json", "User-Agent": "PowFi-distribution/1.0"})
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except (HTTPError, URLError, TimeoutError) as error:
            if attempt == 2:
                raise RuntimeError(f"Could not fetch {url}: {error}") from error
            time.sleep(2**attempt)


def fetch_events(node_url):
    endpoint = f"{node_url.rstrip('/')}/events/contract/{VAULT}"
    # Node cursors advance through event batches, not necessarily individual
    # events. Capture the count first so new deposits do not shift pagination.
    count = get_json(endpoint + "/current-count")
    if not isinstance(count, int) or count < 0:
        raise ValueError("Unexpected node event count")
    events = []
    start = 0
    while start < count:
        limit = min(100, count - start)
        page = get_json(f"{endpoint}?start={start}&limit={limit}")
        next_start = page["nextStart"]
        if next_start <= start or next_start > start + limit:
            raise ValueError("Unexpected node cursor; refusing to report partial history")
        events.extend(page["events"])
        print(f"Fetched event batches {next_start}/{count}", file=sys.stderr)
        start = next_start
    return events


def analyze(events, snapshot_at, source):
    unique = {}
    for event in events:
        tx_id = event.get("txId", event.get("txHash"))
        if not tx_id:
            raise ValueError("Event has no transaction ID")
        key = (tx_id, event["eventIndex"], json.dumps(event["fields"], sort_keys=True))
        unique[key] = event
    stakes = [e for e in unique.values() if e["eventIndex"] == 0]
    if not stakes:
        raise ValueError("No Staked events found")
    by_address = {}
    for event in stakes:
        fields = event["fields"]
        # XAlphToken.Staked: to, referral, alphAmount, xAlphAmount.
        if len(fields) != 4 or fields[0]["type"] != "Address" or fields[2]["type"] != "U256":
            raise ValueError("Unexpected Staked event schema")
        recipient = fields[0]["value"]
        amount = int(fields[2]["value"])
        if amount <= 0:
            raise ValueError("Unexpected non-positive deposit")
        by_address[recipient] = by_address.get(recipient, 0) + amount
    amounts = sorted(by_address.values())
    total = sum(amounts)
    middle = len(amounts) // 2
    # Integer sums retain full attoALPH precision until display conversion.
    median = amounts[middle] / ATTO if len(amounts) % 2 else (amounts[middle - 1] + amounts[middle]) / (2 * ATTO)
    bins = []
    for i, lower in enumerate(THRESHOLDS):
        upper = THRESHOLDS[i + 1] if i + 1 < len(THRESHOLDS) else None
        selected = [a for a in amounts if a >= lower * ATTO and (upper is None or a < upper * ATTO)]
        bins.append({"range": RANGES[i], "lowerInclusiveAlph": lower, "upperExclusiveAlph": upper,
            "addressCount": len(selected), "addressSharePct": len(selected) / len(amounts) * 100,
            "depositedAttoAlph": str(sum(selected)), "depositedAlphSharePct": sum(selected) / total * 100})
    if sum(b["addressCount"] for b in bins) != len(amounts) or sum(int(b["depositedAttoAlph"]) for b in bins) != total:
        raise ValueError("Distribution does not reconcile with address totals")
    large = [a for a in amounts if a >= 100_000 * ATTO]
    return {"snapshotAt": snapshot_at, "source": source, "vaultAddress": VAULT,
        "firstStake": datetime.fromtimestamp(min(e["timestamp"] for e in stakes) / 1000, timezone.utc).isoformat(),
        "lastStake": datetime.fromtimestamp(max(e["timestamp"] for e in stakes) / 1000, timezone.utc).isoformat(),
        "stakeEventCount": len(stakes), "uniqueRecipientAddresses": len(amounts),
        "duplicateRecordsRemoved": len(events) - len(unique),
        "totalAttoAlph": str(total), "totalDepositedAlph": total / ATTO,
        "medianAlphPerAddress": median, "meanAlphPerAddress": total / ATTO / len(amounts),
        "largeAddressSharePct": len(large) / len(amounts) * 100,
        "largeAddressVolumeSharePct": sum(large) / total * 100,
        "bins": bins,
        "methodology": "Sum all Staked-event ALPH amounts by recipient address (field 0). Each recipient contributes one combined observation. Repeated deposits are combined; rewards, scheduled unstakes and cancellations are excluded. Gross historical deposits, not current holdings or unique people; withdrawals and transfers are not subtracted."}, list(unique.values())


def render(summary, output_dir):
    os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "powfi-matplotlib"))
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.lines import Line2D
        from matplotlib.ticker import PercentFormatter
    except ImportError:
        raise RuntimeError("Install matplotlib first: python3 -m pip install matplotlib") from None
    bg, ink, muted, rule = "#f6f6f3", "#252721", "#666b60", "#dfe2d9"
    orange, volume_color = "#db512d", "#596a50"
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "text.color": ink,
        "axes.labelcolor": muted, "xtick.color": muted, "ytick.color": ink,
        "figure.facecolor": bg, "axes.facecolor": bg, "svg.fonttype": "none"})
    fig = plt.figure(figsize=(12, 8), dpi=150)
    fig.text(.07, .942, "POWFI OVERVIEW", color=orange, fontsize=10, weight="bold", va="top")
    fig.text(.93, .942, "COMMUNITY DATA", color=muted, fontsize=9, ha="right", va="top")
    fig.text(.07, .88, "ALPH deposited per staking address", fontsize=24, weight="bold")
    first = datetime.fromisoformat(summary["firstStake"])
    last = datetime.fromisoformat(summary["lastStake"])
    date_range = f"{first:%d %b %Y}–{last:%d %b %Y}"
    fig.text(.07, .839, f"{summary['stakeEventCount']:,} deposits combined into {summary['uniqueRecipientAddresses']:,} addresses  ·  {date_range}", fontsize=11, color=muted)
    fig.add_artist(Line2D([.07, .93], [.807, .807], transform=fig.transFigure, color=rule, linewidth=1))
    metrics = [(.07, "MEDIAN PER ADDRESS", f"{summary['medianAlphPerAddress']:,.0f} ALPH", orange),
        (.385, "AVERAGE PER ADDRESS", f"{summary['meanAlphPerAddress']:,.0f} ALPH", ink),
        (.73, "STAKING ADDRESSES", f"{summary['uniqueRecipientAddresses']:,}", ink)]
    for x, label, value, color in metrics:
        fig.text(x, .766, label, fontsize=9, color=muted, weight="bold")
        fig.text(x, .712, value, fontsize=23, color=color, weight="bold")
    fig.text(.07, .657, f"100,000+ ALPH addresses: {summary['largeAddressSharePct']:.1f}% of addresses, {summary['largeAddressVolumeSharePct']:.1f}% of deposited ALPH.", fontsize=11.1)
    bins = summary["bins"]
    count_ax = fig.add_axes([.205, .228, .32, .345])
    volume_ax = fig.add_axes([.625, .228, .285, .345], sharey=count_ax)
    rows = list(range(len(bins)))
    counts = [b["addressCount"] for b in bins]
    count_ax.barh(rows, counts, color=orange, height=.57, zorder=3)
    volume_ax.barh(rows, [b["depositedAlphSharePct"] for b in bins], color=volume_color, height=.57, zorder=3)
    count_ax.set_yticks(rows, RANGES, fontsize=9.7)
    count_ax.set_ylim(5.6, -.6)
    count_ax.set_xlim(0, max(counts) * 1.7)
    volume_ax.set_xlim(0, max(62, max(b["depositedAlphSharePct"] for b in bins) + 15))
    volume_ax.xaxis.set_major_formatter(PercentFormatter(xmax=100, decimals=0))
    volume_ax.tick_params(axis="y", labelleft=False)
    for ax in (count_ax, volume_ax):
        for spine in ax.spines.values():
            spine.set_visible(False)
        ax.set_axisbelow(True)
        ax.grid(axis="x", color=rule, linewidth=.7)
        ax.tick_params(axis="both", length=0, pad=8, labelsize=9)
    count_ax.set_xlabel("Number of addresses", fontsize=10, labelpad=14)
    volume_ax.set_xlabel("Share of total deposited ALPH (%)", fontsize=10, labelpad=14)
    count_ax.text(0, 1.10, "ADDRESS DISTRIBUTION", transform=count_ax.transAxes, fontsize=10, weight="bold")
    count_ax.text(-.42, 1.10, "TOTAL (ALPH)", transform=count_ax.transAxes, fontsize=9, color=muted, weight="bold")
    volume_ax.text(0, 1.10, "ALPH VOLUME", transform=volume_ax.transAxes, fontsize=10, weight="bold")
    for row, b in enumerate(bins):
        count_ax.text(b["addressCount"] + max(counts) * .035, row, f"{b['addressCount']}  ({b['addressSharePct']:.1f}%)", va="center", fontsize=9.5)
        share = b["depositedAlphSharePct"]
        value = "<0.1%" if 0 < share < .1 else f"{share:.1f}%"
        volume_ax.text(share + 1.5, row, value, va="center", fontsize=9.5)
    fig.add_artist(Line2D([.07, .93], [.14, .14], transform=fig.transFigure, color=rule, linewidth=1))
    fig.text(.07, .108, "All deposits to the same address are summed. These are gross deposits, not current balances.", fontsize=9.4, color=muted)
    fig.text(.07, .081, "Source: Alephium mainnet xALPH vault Staked events · Duplicate records removed · Amounts in ALPH.", fontsize=8.5, color=muted)
    snapshot = datetime.fromisoformat(summary["snapshotAt"].replace("Z", "+00:00"))
    fig.text(.07, .057, f"Snapshot: {snapshot:%d %b %Y, %H:%M} UTC · Withdrawals, transfers, rewards and cancellations are not included.", fontsize=8.5, color=muted)
    for extension in ("png", "svg"):
        fig.savefig(output_dir / f"powfi-deposit-distribution.{extension}", dpi=150, facecolor=bg)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[2] / "output" / "staking-distribution")
    parser.add_argument("--fullnode", "--node-url", dest="node_url", default=NODE,
        metavar="URL", help=f"Alephium mainnet fullnode base URL (default: {NODE})")
    parser.add_argument("--events-file", type=Path, nargs="+", help="Optional saved node/explorer JSON files for offline re-runs")
    parser.add_argument("--snapshot-at", help="Original ISO timestamp for offline data (required with --events-file)")
    args = parser.parse_args()
    if args.events_file and not args.snapshot_at:
        parser.error("--events-file requires --snapshot-at to avoid mislabeling old data as live")
    if args.snapshot_at and not args.events_file:
        parser.error("--snapshot-at is only for offline data")
    snapshot_at = args.snapshot_at or datetime.now(timezone.utc).isoformat()
    if args.events_file:
        events = []
        for file in args.events_file:
            page = json.loads(file.read_text())
            events.extend(page if isinstance(page, list) else page["events"])
        source = "Saved Alephium mainnet node/explorer events"
    else:
        events = fetch_events(args.node_url)
        source = f"{args.node_url.rstrip('/')}/events/contract/{VAULT}"
    summary, unique_events = analyze(events, snapshot_at, source)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    render(summary, args.output_dir)
    (args.output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (args.output_dir / "staking-events.json").write_text(json.dumps(unique_events, indent=2) + "\n")
    print(f"Combined {summary['stakeEventCount']:,} deposits into {summary['uniqueRecipientAddresses']:,} addresses.")
    print(f"Median: {summary['medianAlphPerAddress']:,.2f} ALPH | Average: {summary['meanAlphPerAddress']:,.2f} ALPH")
    print(f"Image (1800×1200): {args.output_dir / 'powfi-deposit-distribution.png'}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, KeyError, OSError) as error:
        sys.exit(f"Error: {error}")
