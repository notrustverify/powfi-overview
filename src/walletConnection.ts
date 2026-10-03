import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AlephiumWalletProvider, AlephiumConnectButton, useWallet, useAlephiumConnectContext, createWalletConnectConnector, createDesktopWalletConnector } from '@alephium/web3-react'
import { groupOfAddress } from '@alephium/web3'
import { XALPH_VAULT_ADDRESS } from './chain.ts'
import { updateStakingWallet, setStakingWalletActions } from './staking.ts'

type Controls = { show?: () => void; disconnect: () => Promise<void> }

// A stale remote session can wait indefinitely for an offline wallet. Keep
// remote connections explicit so the method chooser remains available.
const connectors = {
  walletConnect: { ...createWalletConnectConnector(), autoConnect: undefined },
  desktopWallet: { ...createDesktopWalletConnector(), autoConnect: undefined },
}

function WalletBridge({ controls }: { controls: Controls }): null {
  const wallet = useWallet()
  const context = useAlephiumConnectContext()
  useEffect(() => {
    setStakingWalletActions({
      show: () => controls.show?.(),
      disconnect: async () => {
        await controls.disconnect()
        // Some wallets resolve disconnect without delivering a session-delete
        // callback. Clear the provider too, so Custom.show opens the chooser
        // rather than the previous wallet's profile.
        flushSync(() => {
          context.setAccount(undefined)
          context.setSignerProvider(undefined)
          context.setConnectionStatus('disconnected')
        })
      },
    })
  }, [controls.show, controls.disconnect, context])
  useEffect(() => {
    updateStakingWallet(wallet)
  }, [wallet.connectionStatus, wallet.account, wallet.signer])
  return null
}

export function mountWalletConnection(): void {
  // Keep the provider outside the vanilla page's replaceable HTML. Re-rendering
  // amounts, quotes, or live data must not destroy the wallet session/modal.
  const host = document.createElement('div')
  host.id = 'staking-wallet-provider'
  document.body.append(host)
  createRoot(host).render(createElement(AlephiumWalletProvider, {
    network: 'mainnet', addressGroup: groupOfAddress(XALPH_VAULT_ADDRESS), theme: 'minimal', connectors,
    children: createElement(AlephiumConnectButton.Custom, {
      children: (controls) => createElement(WalletBridge, { controls }),
    }),
  }))
}
