import { GenericExtrinsic } from "@polkadot/types"
import { assert } from "@polkadot/util"
import { HexString } from "@polkadot/util/types"
import Browser from "webextension-polyfill"

import { stateCall } from "./stateCall"

// this type structure is compatible with V1 result object
type ExtrinsicDispatchInfo = {
  partialFee: string // planck
}

export const getExtrinsicDispatchInfo = async (
  chainId: string,
  signedExtrinsic: GenericExtrinsic,
  blockHash?: HexString
): Promise<ExtrinsicDispatchInfo> => {
  assert(
    Browser.extension.getBackgroundPage() === window,
    "@core/util/getExtrinsicDispatchInfo cannot be called from front end, use @ui/util/getExtrinsicDispatchInfo"
  )
  assert(signedExtrinsic.isSigned, "Extrinsic must be signed (or fakeSigned) in order to query fee")

  const len = signedExtrinsic.registry.createType("u32", signedExtrinsic.encodedLength)

  const dispatchInfo = await stateCall(
    chainId,
    "TransactionPaymentApi_query_info",
    "RuntimeDispatchInfo",
    [signedExtrinsic, len],
    blockHash
  )

  return {
    partialFee: dispatchInfo.partialFee.toString(),
  }
}
