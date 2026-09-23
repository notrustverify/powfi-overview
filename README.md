# PowFi Round 0 Dashboard

A static, no-backend dashboard for the PowFi Round 0 campaign on [Alephium](https://alephium.org):
xALPH liquid staking plus the ALPH farming pools. Every number is read live from
mainnet in the browser — there is no server or API key.

## What it shows

- **xALPH liquid staking** (`225WevmFp5ZgzPsyVJTvyp2v2uyKrvp329HfrVmzffnWj`) — ALPH staked vs.
  the 20.5M target, share of circulating ALPH, and the xALPH:ALPH redemption rate.
- **ALPH × USDT farming pool** (`xRF7AKLwpGjWzDpFFnUkdXBALKtotFcnD5XFf2EAyioZ`) — pool TVL vs.
  the $200k target, implied ALPH price, and raw reserves.
- **xALPH × ALPH pool** (`22QumTFozFy6HyndPMna2t4KjjVNGYNATgY2reeV2d6nj`) — TVL and market
  price vs. the vault's redemption rate (peg deviation).

Data sources, all called directly from the client:

| Source | Used for |
|---|---|
| `node.mainnet.alephium.org` (via `@alephium/web3`'s `NodeProvider`) | contract state / reserves |
| `backend.mainnet.alephium.org` (via `@alephium/web3`'s `ExplorerProvider`) | circulating ALPH supply, token metadata |
| CoinGecko public API | ALPH/USD spot price |

The campaign targets (20.5M ALPH staked, $200k pool TVL, 5%/15% target APYs, 15% of
circulating ALPH) are fixed constants in `src/chain.ts` — update them there if a new round changes them.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build   # outputs to dist/
npm run preview # serve the production build locally
```

## Deploy to GitHub Pages

A workflow at `.github/workflows/deploy.yml` builds and publishes `dist/` on every push to
`main`. To enable it:

1. Push this repo to GitHub.
2. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the Actions tab).

The workflow sets Vite's `base` to `/` for the custom domain
`https://powfi.notrustverify.ch`. Configure that hostname in **Settings → Pages →
Custom domain**. Asset URLs must start at the domain root, without `/powfi-overview/`.

If switching back to a `https://<owner>.github.io/<repo-name>/` project URL, change
the workflow's `VITE_BASE` to `/<repo-name>/` and rebuild.
