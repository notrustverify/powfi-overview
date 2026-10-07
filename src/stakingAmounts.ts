const ATTO_PER_ALPH = 10n ** 18n
// Leave a fee buffer in addition to the SDK's 0.1 ALPH funding requirement.
// The wallet calculates the actual network fee before approval.
export const STAKE_FEE_BUFFER = 10n ** 16n

function ungroupStakeInput(value: string): string {
  // Only remove correctly grouped thousands separators; ambiguous pasted
  // decimals such as "1,5" must not silently become a different amount.
  return /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(value) ? value.replaceAll(',', '') : value
}

/** Group the whole amount without rounding or changing unfinished decimals. */
export function formatStakeInput(value: string): string {
  const normalized = ungroupStakeInput(value.trim())
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) return value
  const [whole, fraction] = normalized.split('.')
  return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`)
}

export function stakeAmountText(amount: bigint): string {
  const fraction = (amount % ATTO_PER_ALPH).toString().padStart(18, '0').replace(/0+$/, '')
  return `${amount / ATTO_PER_ALPH}${fraction ? `.${fraction}` : ''}`
}

export function stakeValidation(input: string, available: bigint | undefined, funding: bigint): string {
  if (!input.trim()) return ''
  try {
    const amount = parseStakeAmount(input)
    if (available !== undefined && amount + funding + STAKE_FEE_BUFFER > available) {
      return 'Not enough ALPH. Reduce the amount to leave 0.1 ALPH for transaction funding and a 0.01 ALPH network fee buffer.'
    }
    return ''
  } catch (err) {
    return err instanceof Error ? err.message : 'Enter a valid amount.'
  }
}

/** Parse ALPH without rounding user-specified precision. */
export function parseStakeAmount(value: string): bigint {
  const normalized = ungroupStakeInput(value.trim())
  if (!/^\d+(?:\.\d{1,18})?$/.test(normalized)) {
    throw new Error('Enter a positive ALPH amount with up to 18 decimal places.')
  }
  const [whole, fraction = ''] = normalized.split('.')
  const amount = BigInt(whole) * ATTO_PER_ALPH + BigInt(fraction.padEnd(18, '0'))
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.')
  return amount
}

export function checkStakeFunding(amount: bigint, available: bigint, funding: bigint): void {
  if (amount + funding + STAKE_FEE_BUFFER > available) {
    throw new Error('Not enough ALPH. Keep 0.1 ALPH for transaction funding and a 0.01 ALPH network fee buffer.')
  }
}
