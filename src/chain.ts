import { NodeProvider, ExplorerProvider, tokenIdFromAddress, contractIdFromAddress, binToHex } from '@alephium/web3'

export const NODE_URL = 'https://node.mainnet.alephium.org'
export const EXPLORER_API_URL = 'https://backend.mainnet.alephium.org'
export const EXPLORER_APP_URL = 'https://explorer.alephium.org'
export const POWFI_API_URL = 'https://api.powfi.alephium.org'

export const XALPH_VAULT_ADDRESS = '225WevmFp5ZgzPsyVJTvyp2v2uyKrvp329HfrVmzffnWj'
export const POOL_ALPH_USDT_ADDRESS = 'xRF7AKLwpGjWzDpFFnUkdXBALKtotFcnD5XFf2EAyioZ'
export const POOL_XALPH_ALPH_ADDRESS = '22QumTFozFy6HyndPMna2t4KjjVNGYNATgY2reeV2d6nj'

export const XALPH_TOKEN_ID = binToHex(tokenIdFromAddress(XALPH_VAULT_ADDRESS))
const POOL_ALPH_USDT_ID = binToHex(contractIdFromAddress(POOL_ALPH_USDT_ADDRESS))
const POOL_XALPH_ALPH_ID = binToHex(contractIdFromAddress(POOL_XALPH_ALPH_ADDRESS))

// xALPH vault contract methods (verified against DefiLlama's production PowFi adapter).
const VAULT_METHOD_GET_XALPH_SUPPLY = 3
const VAULT_METHOD_GET_XALPH_BACKING = 13

// Campaign targets, as published for Round 0.
export const TARGETS = {
  stakedAlph: 20_500_000,
  stakingApyPct: 5,
  stakingShareOfCirculatingPct: 15,
  poolTvlUsd: 200_000,
  poolApyPct: 15,
}

const ALPH_DECIMALS = 18

export interface TokenMeta {
  id: string
  symbol: string
  name: string
  decimals: number
}

export interface PoolData {
  address: string
  alphReserve: number
  tokenReserves: { meta: TokenMeta; amount: number }[]
}

export interface PoolPrice {
  tvlUsd: number
  feeRatePct: number
  token0Symbol: string
  token1Symbol: string
  /** Spot price of 1 token0 in token1, read from the pool's current sqrtPriceX96 (pre-fee). */
  price1Per0: number
}

export interface DashboardData {
  fetchedAt: number
  alphPriceUsd: number
  circulatingAlph: number
  vault: {
    alphStaked: number
    xalphIssued: number
    redemptionRate: number // ALPH per xALPH
    currentAprPct: number // live 7-day moving-average APR, from PowFi's own staking stats
    aprIsPartial: boolean
  }
  poolAlphUsdt: { reserves: PoolData; price: PoolPrice }
  poolXalphAlph: { reserves: PoolData; price: PoolPrice }
}

function attoToNumber(atto: string | bigint, decimals: number): number {
  // Safe for display-scale numbers: values here stay well under 2^53 once
  // divided down from atto units, so a plain float division is precise enough.
  return Number(BigInt(atto)) / 10 ** decimals
}

async function fetchAlphPriceUsd(): Promise<number> {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=alephium&vs_currencies=usd')
  if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status}`)
  const json = await res.json()
  const price = json?.alephium?.usd
  if (typeof price !== 'number') throw new Error('Unexpected CoinGecko response shape')
  return price
}

// Reads the vault's own supply/backing getters rather than guessing at raw
// contract field layout — same methods DefiLlama's production PowFi adapter uses.
async function fetchVaultStats(
  nodeProvider: NodeProvider,
): Promise<{ alphStaked: number; xalphIssued: number; redemptionRate: number }> {
  const [supplyResult, backingResult] = await Promise.all([
    nodeProvider.contracts.postContractsCallContract({
      group: 0,
      address: XALPH_VAULT_ADDRESS,
      methodIndex: VAULT_METHOD_GET_XALPH_SUPPLY,
    }),
    nodeProvider.contracts.postContractsCallContract({
      group: 0,
      address: XALPH_VAULT_ADDRESS,
      methodIndex: VAULT_METHOD_GET_XALPH_BACKING,
    }),
  ])
  if (!('returns' in supplyResult) || !('returns' in backingResult)) {
    throw new Error('xALPH vault contract call failed')
  }
  const xalphIssued = attoToNumber(supplyResult.returns[0].value as string, ALPH_DECIMALS)
  const alphStaked = attoToNumber(backingResult.returns[0].value as string, ALPH_DECIMALS)
  return { alphStaked, xalphIssued, redemptionRate: xalphIssued > 0 ? alphStaked / xalphIssued : 1 }
}

interface PowfiStakingStatsResponse {
  apr: string
  isPartial: boolean
}

// PowFi's own staking stats endpoint — the same one powfi.alephium.org/staking
// reads for its "APR" stat: a 7-day moving average of realized staking returns.
async function fetchStakingApr(): Promise<{ currentAprPct: number; aprIsPartial: boolean }> {
  const res = await fetch(`${POWFI_API_URL}/stats/staking`)
  if (!res.ok) throw new Error(`PowFi staking stats API failed: ${res.status}`)
  const s: PowfiStakingStatsResponse = await res.json()
  return { currentAprPct: Number(s.apr) / 100, aprIsPartial: s.isPartial }
}

interface PowfiPoolApiResponse {
  tvl: number
  feeRate: number
  sqrtPriceX96: string
  token0: { symbol: string; decimals: number }
  token1: { symbol: string; decimals: number }
}

// PowFi's own pool API — the same live pool state (sqrtPriceX96, tvl) that
// powers the swap UI. This is required for concentrated-liquidity pools:
// their raw on-chain reserves are the sum across every LP's price range and
// do not reflect the current tradeable price (verified against real swap
// quotes — a naive reserves ratio was off by 7-40x).
async function fetchPoolPrice(poolId: string): Promise<PoolPrice> {
  const res = await fetch(`${POWFI_API_URL}/pools/${poolId}`)
  if (!res.ok) throw new Error(`PowFi pool API failed: ${res.status}`)
  const p: PowfiPoolApiResponse = await res.json()

  const Q96 = 2 ** 96
  const sqrtPrice = Number(BigInt(p.sqrtPriceX96)) / Q96
  const price1Per0 = sqrtPrice * sqrtPrice * 10 ** (p.token0.decimals - p.token1.decimals)

  return {
    tvlUsd: Number(p.tvl),
    feeRatePct: Number(p.feeRate) * 100,
    token0Symbol: p.token0.symbol,
    token1Symbol: p.token1.symbol,
    price1Per0,
  }
}

async function fetchPool(
  nodeProvider: NodeProvider,
  address: string,
  tokenMetaById: Map<string, TokenMeta>,
): Promise<PoolData> {
  const state = await nodeProvider.contracts.getContractsAddressState(address)
  const alphReserve = attoToNumber(state.asset.attoAlphAmount, ALPH_DECIMALS)
  const tokenReserves = (state.asset.tokens ?? []).map((t) => {
    const meta = tokenMetaById.get(t.id) ?? { id: t.id, symbol: t.id.slice(0, 6), name: 'Unknown token', decimals: 18 }
    return { meta, amount: attoToNumber(t.amount, meta.decimals) }
  })
  return { address, alphReserve, tokenReserves }
}

export async function fetchDashboardData(): Promise<DashboardData> {
  const nodeProvider = new NodeProvider(NODE_URL)
  const explorer = new ExplorerProvider(EXPLORER_API_URL)

  const [poolAlphUsdtStateProbe, poolXalphAlphStateProbe] = await Promise.all([
    nodeProvider.contracts.getContractsAddressState(POOL_ALPH_USDT_ADDRESS),
    nodeProvider.contracts.getContractsAddressState(POOL_XALPH_ALPH_ADDRESS),
  ])
  const allTokenIds = Array.from(
    new Set([
      ...(poolAlphUsdtStateProbe.asset.tokens ?? []).map((t) => t.id),
      ...(poolXalphAlphStateProbe.asset.tokens ?? []).map((t) => t.id),
    ]),
  )

  const [alphPriceUsd, circulatingAlph, metaList, vaultStats, stakingApr, poolAlphUsdtPrice, poolXalphAlphPrice] = await Promise.all([
    fetchAlphPriceUsd(),
    explorer.infos.getInfosSupplyCirculatingAlph(),
    explorer.tokens.postTokensFungibleMetadata(allTokenIds),
    fetchVaultStats(nodeProvider),
    fetchStakingApr(),
    fetchPoolPrice(POOL_ALPH_USDT_ID),
    fetchPoolPrice(POOL_XALPH_ALPH_ID),
  ])

  const tokenMetaById = new Map<string, TokenMeta>(
    metaList.map((m) => [m.id, { id: m.id, symbol: m.symbol, name: m.name, decimals: Number(m.decimals) }]),
  )

  const [poolAlphUsdtReserves, poolXalphAlphReserves] = await Promise.all([
    fetchPool(nodeProvider, POOL_ALPH_USDT_ADDRESS, tokenMetaById),
    fetchPool(nodeProvider, POOL_XALPH_ALPH_ADDRESS, tokenMetaById),
  ])

  return {
    fetchedAt: Date.now(),
    alphPriceUsd,
    circulatingAlph: Number(circulatingAlph),
    vault: { ...vaultStats, ...stakingApr },
    poolAlphUsdt: { reserves: poolAlphUsdtReserves, price: poolAlphUsdtPrice },
    poolXalphAlph: { reserves: poolXalphAlphReserves, price: poolXalphAlphPrice },
  }
}
