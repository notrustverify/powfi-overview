# Utilities

![ALPH deposited per staking address](../output/staking-distribution/powfi-deposit-distribution.png)

## Staking distribution image

[scripts/staking-distribution.py](scripts/staking-distribution.py) fetches PowFi
staking events and combines all deposits to the same recipient address into one
observation. It generates an 1800×1200 shareable PNG, an SVG and the source data.

### Setup

Use Python 3.10 or newer. From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r misc/scripts/requirements-staking-distribution.txt
```

### Run

From the repository root, with the virtual environment activated:

```bash
python misc/scripts/staking-distribution.py
```

If your terminal is already in `misc`, run:

```bash
../.venv/bin/python scripts/staking-distribution.py
```

Each run fetches fresh events. To choose a fullnode, pass its base URL:

```bash
python misc/scripts/staking-distribution.py --fullnode https://node.mainnet.alephium.org
```

`--node-url` is an alias for `--fullnode`. The node must be synced to Alephium
mainnet and expose the vault's complete indexed contract-event history through
an API accessible without authentication.

To change the output directory or see all options:

```bash
python misc/scripts/staking-distribution.py --output-dir ./output/share
python misc/scripts/staking-distribution.py --help
```

### Output

Files are written to [output/staking-distribution](../output/staking-distribution/)
by default:

- `powfi-deposit-distribution.png`: shareable image.
- `powfi-deposit-distribution.svg`: scalable chart.
- `summary.json`: statistics, distribution bins, snapshot date and methodology.
- `staking-events.json`: deduplicated source events.

Each run replaces the generated files. Use a different `--output-dir` to preserve
an older snapshot. Output paths are relative to the working directory when you
specify them; the default output directory is always relative to the repository.

### Calculation

Multiple deposits to the same recipient address are summed before calculating
the mean, median and distribution. These are cumulative gross deposits, not
current balances: withdrawals, xALPH transfers, rewards and unstake cancellations
are not added or subtracted. An address does not necessarily represent one person.
