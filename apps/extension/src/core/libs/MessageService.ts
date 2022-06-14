// Copyright 2019-2021 @polkadot/extension authors & contributors
// SPDX-License-Identifier: Apache-2.0

// Adapted from https://github.com/polkadot-js/extension/

import type {
  MessageTypes,
  MessageTypesWithNoSubscriptions,
  MessageTypesWithNullRequest,
  MessageTypesWithSubscriptions,
  RequestTypes,
  ResponseTypes,
  SubscriptionMessageTypes,
  TransportRequestMessage,
  TransportResponseMessage,
  OriginTypes,
  UnsubscribeFn,
  Port,
} from "core/types"
import * as Sentry from "@sentry/browser"
import { EthProviderRpcError, ETH_ERROR_EIP1474_INTERNAL_ERROR } from "@core/injectEth/types"

export interface Handler {
  resolve: (data?: any) => void
  reject: (error: Error) => void
  subscriber?: (data: unknown) => void
}

export type Handlers = Record<string, Handler>

type MessageServiceConstructorArgs = {
  origin: OriginTypes
  messageSource?: Port | Window
}

export default class MessageService {
  handlers: Handlers = {}
  idCounter = 0
  origin = "talisman-page"
  messageSource: Port | Window = window

  constructor({ origin, messageSource }: MessageServiceConstructorArgs) {
    if (origin === "talisman-extension" && !messageSource) {
      throw Error(
        "An instance of chrome.runtime.Port must be provided as 'messageSource' when used with extension as origin"
      )
    } else if (messageSource) {
      this.messageSource = messageSource
    }
    this.origin = origin
    this.handleResponse = this.handleResponse.bind(this)
    this.sendMessage = this.sendMessage.bind(this)
  }

  // a generic message sender that creates an event, returning a promise that will
  // resolve once the event is resolved (by the response listener just below this)
  sendMessage<TMessageType extends MessageTypesWithNullRequest>(
    message: TMessageType
  ): Promise<ResponseTypes[TMessageType]>
  sendMessage<TMessageType extends MessageTypesWithNoSubscriptions>(
    message: TMessageType,
    request: RequestTypes[TMessageType]
  ): Promise<ResponseTypes[TMessageType]>
  sendMessage<TMessageType extends MessageTypesWithSubscriptions>(
    message: TMessageType,
    request: RequestTypes[TMessageType],
    subscriber: (data: SubscriptionMessageTypes[TMessageType]) => void
  ): Promise<ResponseTypes[TMessageType]>

  sendMessage<TMessageType extends MessageTypes>(
    message: TMessageType,
    request?: RequestTypes[TMessageType],
    subscriber?: (data: unknown) => void
  ): Promise<ResponseTypes[TMessageType]> {
    return new Promise((resolve, reject): void => {
      const id = `${Date.now()}.${++this.idCounter}`

      this.handlers[id] = {
        reject,
        resolve,
        subscriber,
      }
      const transportRequestMessage: TransportRequestMessage<TMessageType> = {
        id,
        message,
        origin: this.origin as OriginTypes,
        request: request || (null as RequestTypes[TMessageType]),
      }

      this.messageSource.postMessage(transportRequestMessage, "*")
    })
  }

  /**
   * Should be used for internal/private messages only
   */
  subscribe<TMessageType extends MessageTypesWithSubscriptions>(
    message: TMessageType,
    request: RequestTypes[TMessageType],
    subscriber: (data: SubscriptionMessageTypes[TMessageType]) => void
  ): UnsubscribeFn {
    const id = `${Date.now()}.${++this.idCounter}`

    // mock the promise resolve/reject methods
    this.handlers[id] = {
      reject: (error) => {
        Sentry.captureException(new Error(`subscription failed`), {
          extra: { id, message, error: error.toString() },
        })
      },
      resolve: () => {},
      subscriber,
    }
    const transportRequestMessage: TransportRequestMessage<TMessageType> = {
      id,
      message,
      origin: this.origin as OriginTypes,
      request: request || (null as RequestTypes[TMessageType]),
    }

    this.messageSource.postMessage(transportRequestMessage, "*")

    return () => {
      this.sendMessage("pri(unsubscribe)", { id }).then(() => delete this.handlers[id])
    }
  }

  handleResponse<TMessageType extends MessageTypes>(
    data: TransportResponseMessage<TMessageType> & {
      subscription?: string
      code?: number
      isEthProviderRpcError?: boolean
    }
  ): void {
    const handler = this.handlers[data.id]
    if (!handler) {
      const { id, error, subscription, response } = data
      Sentry.captureException(new Error(`No handler for this response`), {
        tags: { id, error, subscription, response: response as any },
      })
      return
    }

    if (!handler.subscriber) {
      delete this.handlers[data.id]
    }

    if (data.subscription && handler.subscriber) (handler.subscriber as Function)(data.subscription)
    else if (data.error) {
      if (data.isEthProviderRpcError)
        handler.reject(
          new EthProviderRpcError(data.error, data.code ?? ETH_ERROR_EIP1474_INTERNAL_ERROR)
        )
      else handler.reject(new Error(data.error))
    } else handler.resolve(data.response)
  }
}
