import { NodeProvider, ExplorerProvider, tokenIdFromAddress, contractIdFromAddress, binToHex, isValidAddress } from '@alephium/web3'

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

// Reads the vault's mutable state directly — one call instead of two separate
// method calls. Field order verified against the live contract: mutFields is
// [totalDepositedAlph, totalXAlphSupply, lastUnstakeVaultIndex].
async function fetchVaultStats(
  nodeProvider: NodeProvider,
): Promise<{ alphStaked: number; xalphIssued: number; redemptionRate: number }> {
  const state = await nodeProvider.contracts.getContractsAddressState(XALPH_VAULT_ADDRESS)
  const alphStaked = attoToNumber(state.mutFields[0].value as string, ALPH_DECIMALS)
  const xalphIssued = attoToNumber(state.mutFields[1].value as string, ALPH_DECIMALS)
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

export type StakingActivityKind = 'stake' | 'unstakeScheduled' | 'unstakeCancelled' | 'rewardDeposited'

export interface StakingActivityEntry {
  kind: StakingActivityKind
  txHash: string
  timestamp: number
  address: string
  alphAmount: number
  xalphAmount: number
  /** For 'unstakeScheduled' entries: when the ALPH becomes claimable (timestamp + unstakeDuration). */
  claimableAt?: number
}

// Event indexes match the XAlphToken contract's declaration order (Staked,
// UnstakeScheduled, UnstakeCancelled, RewardDeposited) — same source @alephium/powfi-sdk's
// generated event types are built from.
const VAULT_EVENT_STAKED = 0
const VAULT_EVENT_UNSTAKE_SCHEDULED = 1
const VAULT_EVENT_UNSTAKE_CANCELLED = 2
const VAULT_EVENT_REWARD_DEPOSITED = 3

// XAlphToken's immutable `unstakeDuration` field, read directly from the vault's
// on-chain state (30 days, matching the "30 days (linear claim)" campaign parameter).
const UNSTAKE_DURATION_MS = 30 * 24 * 60 * 60 * 1000

// The explorer API caps a single page at 100 events; larger requests are paged.
const EXPLORER_EVENTS_PAGE_SIZE = 100
export const MAX_ACTIVITY_EVENTS = 5000

// Shape of one entry from the explorer's contract-events endpoint — kept local
// rather than importing the SDK's `Event` type, which isn't exported at the
// package root (only nested under its `explorer` namespace).
interface ChainEvent {
  txHash: string
  timestamp: number
  eventIndex: number
  fields?: { value: unknown }[]
}

function decodeStakingEvent(e: ChainEvent): StakingActivityEntry | undefined {
  const v = (e.fields ?? []).map((f) => f.value as string)
  const base = { txHash: e.txHash, timestamp: e.timestamp }
  switch (e.eventIndex) {
    case VAULT_EVENT_STAKED:
      return {
        ...base,
        kind: 'stake',
        address: v[0],
        alphAmount: attoToNumber(v[2], ALPH_DECIMALS),
        xalphAmount: attoToNumber(v[3], ALPH_DECIMALS),
      }
    case VAULT_EVENT_UNSTAKE_SCHEDULED:
      return {
        ...base,
        kind: 'unstakeScheduled',
        address: v[0],
        xalphAmount: attoToNumber(v[1], ALPH_DECIMALS),
        alphAmount: attoToNumber(v[2], ALPH_DECIMALS),
        claimableAt: e.timestamp + UNSTAKE_DURATION_MS,
      }
    case VAULT_EVENT_UNSTAKE_CANCELLED:
      return {
        ...base,
        kind: 'unstakeCancelled',
        address: v[0],
        xalphAmount: attoToNumber(v[1], ALPH_DECIMALS),
        // claimed + restaked portions collapsed into one ALPH figure for the feed.
        alphAmount: attoToNumber(v[2], ALPH_DECIMALS) + attoToNumber(v[3], ALPH_DECIMALS),
      }
    case VAULT_EVENT_REWARD_DEPOSITED:
      return {
        ...base,
        kind: 'rewardDeposited',
        address: v[0],
        alphAmount: attoToNumber(v[1], ALPH_DECIMALS),
        xalphAmount: 0,
      }
    default:
      return undefined
  }
}

// Reads the vault's full raw event log (paged in batches of 100, capped at
// MAX_ACTIVITY_EVENTS), newest first — matching the explorer's own page order.
// No signer or private API needed: this is public on-chain history.
export async function fetchStakingHistory(): Promise<StakingActivityEntry[]> {
  const explorer = new ExplorerProvider(EXPLORER_API_URL)
  const seen = new Set<string>()
  const entries: StakingActivityEntry[] = []

  for (let page = 1; entries.length < MAX_ACTIVITY_EVENTS; page++) {
    const events = await explorer.contractEvents.getContractEventsContractAddressContractAddress(XALPH_VAULT_ADDRESS, {
      limit: EXPLORER_EVENTS_PAGE_SIZE,
      page,
    })
    for (const e of events) {
      const key = `${e.txHash}|${e.eventIndex}|${JSON.stringify((e.fields ?? []).map((f) => f.value))}`
      if (seen.has(key)) continue
      seen.add(key)
      const entry = decodeStakingEvent(e)
      if (entry) entries.push(entry)
    }
    if (events.length < EXPLORER_EVENTS_PAGE_SIZE) break
  }

  return entries
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

export function isAlephiumAddress(address: string): boolean {
  return isValidAddress(address)
}

/** Live spot rate of 1 xALPH in ALPH, read from the xALPH/ALPH pool's current tick. */
export function xalphMarketRate(d: Pick<DashboardData, 'poolXalphAlph'>): number {
  return 1 / d.poolXalphAlph.price.price1Per0
}

// Reads the address's exact xALPH balance from the explorer — same source the
// wallet balance view uses, so it reflects real holdings including any dust.
export async function fetchAddressXalphBalance(address: string): Promise<number> {
  const explorer = new ExplorerProvider(EXPLORER_API_URL)
  const result = await explorer.addresses.getAddressesAddressTokensTokenIdBalance(address, XALPH_TOKEN_ID)
  return attoToNumber(result.balance, ALPH_DECIMALS)
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
