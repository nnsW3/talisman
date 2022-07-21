import { ChainId } from "@core/domains/chains/types"
import { EvmNetworkId } from "@core/domains/ethereum/types"
import { TokenId } from "@core/domains/tokens/types"
import { Address, AddressesByChain } from "@core/types/base"

import { BalanceStorage, BalancesStorage } from "./storages"

export { Balances, Balance, BalanceFormatter } from "./balances"
export type { BalanceStorage, BalancesStorage }

export type BalancesUpdate = BalancesUpdateReset | BalancesUpdateUpsert | BalancesUpdateDelete
export type BalancesUpdateReset = { type: "reset"; balances: BalancesStorage }
export type BalancesUpdateUpsert = { type: "upsert"; balances: BalancesStorage }
export type BalancesUpdateDelete = { type: "delete"; balances: string[] }

export interface RequestBalance {
  chainId?: ChainId
  evmNetworkId?: EvmNetworkId
  tokenId: TokenId
  address: Address
}

export interface RequestBalancesByParamsSubscribe {
  addressesByChain: AddressesByChain
}

export type BalanceLockType = "democracy" | "staking" | "vesting" | "other"
export type LockedBalance = {
  type: BalanceLockType
  amount: string //planck
}

export type RequestBalanceLocks = {
  chainId: ChainId
  addresses: Address[]
}

export type ResponseBalanceLocks = Record<Address, LockedBalance[]>

export interface BalancesMessages {
  // balance message signatures
  "pri(balances.get)": [RequestBalance, BalanceStorage]
  "pri(balances.locks.get)": [RequestBalanceLocks, ResponseBalanceLocks]
  "pri(balances.subscribe)": [null, boolean, boolean]
  "pri(balances.byparams.subscribe)": [RequestBalancesByParamsSubscribe, boolean, BalancesUpdate]
}
