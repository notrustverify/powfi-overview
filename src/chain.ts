import { NodeProvider, ExplorerProvider, tokenIdFromAddress, binToHex } from '@alephium/web3'

export const NODE_URL = 'https://node.mainnet.alephium.org'
export const EXPLORER_API_URL = 'https://backend.mainnet.alephium.org'
export const EXPLORER_APP_URL = 'https://explorer.alephium.org'

export const XALPH_VAULT_ADDRESS = '225WevmFp5ZgzPsyVJTvyp2v2uyKrvp329HfrVmzffnWj'
export const POOL_ALPH_USDT_ADDRESS = 'xRF7AKLwpGjWzDpFFnUkdXBALKtotFcnD5XFf2EAyioZ'
export const POOL_XALPH_ALPH_ADDRESS = '22QumTFozFy6HyndPMna2t4KjjVNGYNATgY2reeV2d6nj'

export const XALPH_TOKEN_ID = binToHex(tokenIdFromAddress(XALPH_VAULT_ADDRESS))

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

export interface DashboardData {
  fetchedAt: number
  alphPriceUsd: number
  circulatingAlph: number
  vault: {
    alphStaked: number
    xalphIssued: number
    redemptionRate: number // ALPH per xALPH
  }
  poolAlphUsdt: PoolData
  poolXalphAlph: PoolData
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

  const vaultState = await nodeProvider.contracts.getContractsAddressState(XALPH_VAULT_ADDRESS)
  const vaultTokenIds = (vaultState.asset.tokens ?? []).map((t) => t.id)

  // Discover every token held across the vault + both pools in one metadata call.
  const poolAlphUsdtStateProbe = await nodeProvider.contracts.getContractsAddressState(POOL_ALPH_USDT_ADDRESS)
  const poolXalphAlphStateProbe = await nodeProvider.contracts.getContractsAddressState(POOL_XALPH_ALPH_ADDRESS)
  const allTokenIds = Array.from(
    new Set([
      ...vaultTokenIds,
      ...(poolAlphUsdtStateProbe.asset.tokens ?? []).map((t) => t.id),
      ...(poolXalphAlphStateProbe.asset.tokens ?? []).map((t) => t.id),
    ]),
  )

  const [alphPriceUsd, circulatingAlph, metaList] = await Promise.all([
    fetchAlphPriceUsd(),
    explorer.infos.getInfosSupplyCirculatingAlph(),
    explorer.tokens.postTokensFungibleMetadata(allTokenIds),
  ])

  const tokenMetaById = new Map<string, TokenMeta>(
    metaList.map((m) => [m.id, { id: m.id, symbol: m.symbol, name: m.name, decimals: Number(m.decimals) }]),
  )

  const alphStaked = attoToNumber(vaultState.asset.attoAlphAmount, ALPH_DECIMALS)
  // mutFields[0] = totalStaked, mutFields[1] = totalXalphIssued, verified against
  // the live vault (they track attoAlphAmount almost exactly at genesis parity).
  // Fall back to a 1:1 peg if the vault's field layout ever changes.
  const xalphIssuedField = vaultState.mutFields[1]
  const xalphIssued =
    xalphIssuedField && typeof xalphIssuedField.value === 'string'
      ? attoToNumber(xalphIssuedField.value, ALPH_DECIMALS)
      : alphStaked

  const [poolAlphUsdt, poolXalphAlph] = await Promise.all([
    fetchPool(nodeProvider, POOL_ALPH_USDT_ADDRESS, tokenMetaById),
    fetchPool(nodeProvider, POOL_XALPH_ALPH_ADDRESS, tokenMetaById),
  ])

  return {
    fetchedAt: Date.now(),
    alphPriceUsd,
    circulatingAlph: Number(circulatingAlph),
    vault: {
      alphStaked,
      xalphIssued,
      redemptionRate: xalphIssued > 0 ? alphStaked / xalphIssued : 1,
    },
    poolAlphUsdt,
    poolXalphAlph,
  }
}

export function poolTvlUsd(pool: PoolData, alphPriceUsd: number, xalphToAlphRate: number): number {
  const alphValue = pool.alphReserve * alphPriceUsd
  const tokenValue = pool.tokenReserves.reduce((sum, r) => {
    const priceUsd = r.meta.symbol === 'XALPH' ? xalphToAlphRate * alphPriceUsd : usdStablePriceGuess(r.meta.symbol, alphPriceUsd)
    return sum + r.amount * priceUsd
  }, 0)
  return alphValue + tokenValue
}

function usdStablePriceGuess(symbol: string, alphPriceUsd: number): number {
  if (/USDT|USDC|DAI/i.test(symbol)) return 1
  // Unknown, non-stable token held by a pool (e.g. an incentive reserve):
  // we don't have a price feed for it, so it's excluded from TVL (0).
  void alphPriceUsd
  return 0
}
