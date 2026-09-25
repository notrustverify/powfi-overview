// Isolated from chain.ts on purpose: @alephium/powfi-sdk pulls in decimal.js,
// bignumber.js, and every CLMM/CPMM/staking contract artifact (~200KB gzipped).
// Keeping it out of chain.ts means the Activity page — which never needs LP or
// unstake-vault data — doesn't pay for it, and main.ts only loads it via a
// dynamic import() when the unstake calculator is actually used.
import { ExplorerProvider, addressFromContractId, contractIdFromAddress, binToHex, ALPH_TOKEN_ID } from '@alephium/web3'
import { Powfi, ClmmContracts, TickUtils, ClmmLiquidityUtils, PoolUtils } from '@alephium/powfi-sdk'
import type { Powfi as PowfiInstance } from '@alephium/powfi-sdk'
import { EXPLORER_API_URL, XALPH_TOKEN_ID, POOL_XALPH_ALPH_ADDRESS } from './chain.ts'

const ALPH_DECIMALS = 18
const EXPLORER_EVENTS_PAGE_SIZE = 100
const POOL_XALPH_ALPH_ID = binToHex(contractIdFromAddress(POOL_XALPH_ALPH_ADDRESS))

function attoToNumber(atto: string | bigint, decimals: number): number {
  return Number(BigInt(atto)) / 10 ** decimals
}

let powfiSingleton: PowfiInstance | null = null
function getPowfi(): PowfiInstance {
  if (!powfiSingleton) {
    powfiSingleton = Powfi.load({ networkId: 'mainnet' })
    powfiSingleton.setCurrentProviders()
  }
  return powfiSingleton
}

export interface PendingUnstake {
  vaultIndex: bigint
  totalUnstakeAmount: number // ALPH, already burned from xALPH supply — not affected by redemption/market rate
  claimableNow: number // ALPH, linearly vested so far
  claimableAt: number // ms timestamp when the full amount is claimable
}

// Queries the AlphUnstakeVault directly by address (powfi.staking) — no event
// scanning needed, the vault tracks each user's pending requests itself.
export async function fetchPendingUnstakes(address: string): Promise<PendingUnstake[]> {
  const powfi = getPowfi()
  const indexes = await powfi.staking.getActiveUnstakeVaultIndexes(address)
  return Promise.all(
    indexes.map(async (vaultIndex) => {
      const [state, claimable] = await Promise.all([
        powfi.staking.getAlphUnstakeVaultState(address, vaultIndex),
        powfi.staking.getClaimableAmount(address, vaultIndex),
      ])
      return {
        vaultIndex,
        totalUnstakeAmount: attoToNumber(state.fields.totalUnstakeAmount, ALPH_DECIMALS),
        claimableNow: attoToNumber(claimable, ALPH_DECIMALS),
        claimableAt: Number(state.fields.unstakeStartTime) + Number(state.fields.unstakeDuration),
      }
    }),
  )
}

export interface LpPosition {
  tickLower: bigint
  tickUpper: bigint
  xalphAmount: number
}

// CLMM Pool contract's event declaration order (Initialize, SwapStart, SwapStep,
// Swap, Mint, ...) — Mint is what we need: it carries the owner's tick range.
const CLMM_POOL_MINT_EVENT_INDEX = 4

// Finds the address's open positions in the xALPH/ALPH pool and computes their
// current ALPH/xALPH composition. Three steps, verified against a real position:
// 1) position NFTs are just tokens in the owner's wallet, identified via the
//    explorer's batched NFT-metadata lookup (collectionId == the pool's own id);
// 2) each NFT's tick range comes from the pool's own Mint events for that owner
//    (Position's on-chain fields don't store the tick range);
// 3) TickUtils + ClmmLiquidityUtils (the SDK's Uniswap-V3 math) convert the
//    position's live `liquidity` at the pool's current price into real amounts.
export async function fetchXalphLpPositions(address: string): Promise<LpPosition[]> {
  const explorer = new ExplorerProvider(EXPLORER_API_URL)

  const balances = await explorer.addresses.getAddressesAddressTokensBalance(address, { limit: 100 })
  const candidateIds = balances.map((b) => b.tokenId).filter((id) => id !== XALPH_TOKEN_ID)
  if (candidateIds.length === 0) return []

  const nftMeta = await explorer.tokens.postTokensNftMetadata(candidateIds)
  const heldPositionIds = new Set(nftMeta.filter((m) => m.collectionId === POOL_XALPH_ALPH_ID).map((m) => m.id))
  if (heldPositionIds.size === 0) return []

  const tickRanges = new Set<string>()
  for (let page = 1; ; page++) {
    const events = await explorer.contractEvents.getContractEventsContractAddressContractAddressInputAddressInputAddress(
      POOL_XALPH_ALPH_ADDRESS,
      address,
      { limit: EXPLORER_EVENTS_PAGE_SIZE, page },
    )
    for (const e of events) {
      if (e.eventIndex !== CLMM_POOL_MINT_EVENT_INDEX) continue
      const v = (e.fields ?? []).map((f) => f.value as string)
      tickRanges.add(`${v[2]}:${v[3]}`) // tickLower, tickUpper
    }
    if (events.length < EXPLORER_EVENTS_PAGE_SIZE) break
  }

  const powfi = getPowfi()
  const poolState = await powfi.clmm.getPoolState(POOL_XALPH_ALPH_ID)

  const positions: LpPosition[] = []
  for (const key of tickRanges) {
    const [tickLowerStr, tickUpperStr] = key.split(':')
    const tickLower = BigInt(tickLowerStr)
    const tickUpper = BigInt(tickUpperStr)
    const positionId = powfi.clmm.getPositionId(POOL_XALPH_ALPH_ID, address, tickLower, tickUpper)
    if (!heldPositionIds.has(positionId)) continue // fully withdrawn — NFT no longer held

    const state = await ClmmContracts.Position.at(addressFromContractId(positionId)).fetchState()
    if (state.fields.liquidity === 0n) continue

    const sqrtRatioA = TickUtils.getSqrtRatioAtTick(tickLower)
    const sqrtRatioB = TickUtils.getSqrtRatioAtTick(tickUpper)
    // token0 = ALPH, token1 = xALPH (confirmed via getPoolState) — only the xALPH
    // side (amount1) is reported; the ALPH side isn't counted toward "xALPH staked".
    const [, amount1] = ClmmLiquidityUtils.getAmountsForLiquidity(poolState.sqrtPriceX96, sqrtRatioA, sqrtRatioB, state.fields.liquidity)
    positions.push({
      tickLower,
      tickUpper,
      xalphAmount: attoToNumber(amount1 + state.fields.tokensOwed[1], ALPH_DECIMALS), // tokensOwed adds in unclaimed fees
    })
  }
  return positions
}

export interface SwapQuote {
  alphOut: number
  /** Effective execution price vs. the pool's current spot price — fee + size-dependent slippage combined. */
  priceImpactPct: number
}

// A real swap quote for selling xALPH into ALPH on the CLMM pool: simulateSwap()
// pulls the liquidity distribution around the current price, then offlineSwap()
// walks it tick-by-tick (same math the pool itself uses) to get the actual output,
// trading fee and price impact both included — not just amount × spot price.
export async function fetchXalphToAlphSwapQuote(xalphAmount: number): Promise<SwapQuote | null> {
  if (xalphAmount <= 0) return null
  const powfi = getPowfi()
  const poolState = await powfi.clmm.getPoolState(POOL_XALPH_ALPH_ID)

  const amountIn = BigInt(Math.round(xalphAmount * 10 ** ALPH_DECIMALS))
  const quote = await powfi.clmm.simulateSwap({
    configIndex: poolState.configIndex,
    token0: ALPH_TOKEN_ID,
    token1: XALPH_TOKEN_ID,
    zeroForOne: false, // selling xALPH (token1) for ALPH (token0)
    amount: amountIn,
  })
  const amountOut = PoolUtils.offlineSwap(quote, amountIn, poolState.sqrtPriceX96)
  const alphOut = Math.abs(Number(amountOut)) / 10 ** ALPH_DECIMALS

  const Q96 = 2 ** 96
  const sqrtPrice = Number(poolState.sqrtPriceX96) / Q96
  const spotRate = 1 / (sqrtPrice * sqrtPrice) // ALPH per xALPH, pre-fee
  const effectiveRate = alphOut / xalphAmount
  const priceImpactPct = ((effectiveRate - spotRate) / spotRate) * 100

  return { alphOut, priceImpactPct }
}
