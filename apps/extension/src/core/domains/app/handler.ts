import { DEBUG, TALISMAN_WEB_APP_DOMAIN, TEST } from "@core/constants"
import { AccountTypes } from "@core/domains/accounts/types"
import { AppStoreData } from "@core/domains/app/store.app"
import type {
  AnalyticsCaptureRequest,
  LoggedinType,
  ModalOpenRequest,
  OnboardedType,
  RequestLogin,
  RequestOnboard,
  RequestRoute,
  SendFundsOpenRequest,
} from "@core/domains/app/types"
import { getEthDerivationPath } from "@core/domains/ethereum/helpers"
import { genericSubscription } from "@core/handlers/subscriptions"
import { talismanAnalytics } from "@core/libs/Analytics"
import { ExtensionHandler } from "@core/libs/Handler"
import { requestStore } from "@core/libs/requests/store"
import { windowManager } from "@core/libs/WindowManager"
import type { MessageTypes, RequestTypes, ResponseType } from "@core/types"
import { Port } from "@core/types/base"
import keyring from "@polkadot/ui-keyring"
import { assert } from "@polkadot/util"
import { mnemonicGenerate, mnemonicValidate } from "@polkadot/util-crypto"
import { sleep } from "@talismn/util"
import { Subject } from "rxjs"
import Browser from "webextension-polyfill"

import { getPrimaryAccount } from "../accounts/helpers"
import { changePassword } from "./helpers"
import { protector } from "./protector"
import { PasswordStoreData } from "./store.password"

export default class AppHandler extends ExtensionHandler {
  #modalOpenRequest = new Subject<ModalOpenRequest>()

  private async onboard({ pass, passConfirm, mnemonic }: RequestOnboard): Promise<OnboardedType> {
    if (!(DEBUG || TEST)) await sleep(1000)
    assert(pass, "Password cannot be empty")
    assert(passConfirm, "Password confirm cannot be empty")

    assert(pass === passConfirm, "Passwords do not match")

    assert(!(await this.stores.app.getIsOnboarded()), "A root account already exists")

    const accounts = keyring.getAccounts().length
    assert(!accounts, "Accounts already exist")

    // Before any accounts are created, we want to add talisman.xyz as an authorised site with connectAllSubstrate
    this.stores.sites.set({
      [TALISMAN_WEB_APP_DOMAIN]: {
        addresses: [],
        connectAllSubstrate: true,
        id: TALISMAN_WEB_APP_DOMAIN,
        origin: "Talisman",
        url: `https://${TALISMAN_WEB_APP_DOMAIN}`,
      },
    })

    let confirmed = false
    const method = mnemonic ? "import" : "new"
    // no mnemonic passed in generate a mnemonic as needed
    if (!mnemonic) {
      mnemonic = mnemonicGenerate()
    } else {
      // mnemonic is passed in from user
      const isValidMnemonic = mnemonicValidate(mnemonic)
      assert(isValidMnemonic, "Supplied mnemonic is not valid")
      confirmed = true
    }

    const {
      password: transformedPw,
      salt,
      secret,
      check,
    } = await this.stores.password.createPassword(pass)
    assert(transformedPw, "Password creation failed")
    this.stores.password.setPassword(transformedPw)
    await this.stores.password.set({ isTrimmed: false, isHashed: true, salt, secret, check })

    const { pair } = keyring.addUri(mnemonic, transformedPw, {
      name: "My Polkadot Account",
      origin: mnemonic ? AccountTypes.SEED_STORED : AccountTypes.TALISMAN,
    })
    await this.stores.seedPhrase.add(mnemonic, transformedPw, confirmed)

    try {
      // also derive a first ethereum account
      const derivationPath = getEthDerivationPath()
      keyring.addUri(
        `${mnemonic}${derivationPath}`,
        transformedPw,
        {
          name: `My Ethereum Account`,
          origin: AccountTypes.DERIVED,
          parent: pair.address,
          derivationPath,
        },
        "ethereum"
      )
    } catch (err) {
      // do not break onboarding as user couldn't recover from it
      // eslint-disable-next-line no-console
      console.error(err)
    }

    const result = await this.stores.app.setOnboarded(method !== "new")
    talismanAnalytics.capture("onboarded", { method })
    return result
  }

  private async authenticate({ pass }: RequestLogin): Promise<boolean> {
    await new Promise((resolve) =>
      setTimeout(resolve, process.env.NODE_ENV === "production" ? 1000 : 0)
    )

    try {
      const transformedPassword = await this.stores.password.transformPassword(pass)
      const { secret, check } = await this.stores.password.get()
      if (!secret || !check) {
        // attempt to log in via the legacy method
        const primaryAccount = getPrimaryAccount(true)
        assert(primaryAccount, "No primary account, unable to authorise")

        // fetch keyring pair from address
        const pair = keyring.getPair(primaryAccount.address)

        // attempt unlock the pair
        // a successful unlock means authenticated
        pair.unlock(transformedPassword)
        pair.lock()

        // we can now set up the auth secret
        await this.stores.password.setPlaintextPassword(pass)
        await this.stores.password.setupAuthSecret(transformedPassword)
      } else {
        await this.stores.password.authenticate(pass)
      }

      talismanAnalytics.capture("authenticate")
      return true
    } catch (e) {
      this.stores.password.clearPassword()
      return false
    }
  }

  private authStatus(): LoggedinType {
    return this.stores.password.isLoggedIn.value
  }

  private lock(): LoggedinType {
    this.stores.password.clearPassword()
    return this.authStatus()
  }

  private async changePassword({
    currentPw,
    newPw,
    newPwConfirm,
  }: RequestTypes["pri(app.changePassword)"]) {
    // only allow users who have confirmed backing up their seed phrase to change PW
    const mnemonicConfirmed = await this.stores.seedPhrase.get("confirmed")
    assert(
      mnemonicConfirmed,
      "Please backup your seed phrase before attempting to change your password."
    )

    // check given PW
    await this.stores.password.checkPassword(currentPw)

    // test if the two inputs of the new password are the same
    assert(newPw === newPwConfirm, "New password and new password confirmation must match")

    const isHashedAlready = await this.stores.password.get("isHashed")

    let hashedNewPw, newSalt
    if (isHashedAlready) hashedNewPw = await this.stores.password.getHashedPassword(newPw)
    else {
      // need to create a new password and salt
      const { salt, password } = await this.stores.password.createPassword(newPw)
      hashedNewPw = password
      newSalt = salt
    }

    const transformedPw = await this.stores.password.transformPassword(currentPw)
    const result = await changePassword({ currentPw: transformedPw, newPw: hashedNewPw })
    if (!result.ok) throw Error(result.val)

    // update password secret
    const secretResult = await this.stores.password.createAuthSecret(hashedNewPw)
    const pwStoreData: Partial<PasswordStoreData> = {
      ...secretResult,
      isTrimmed: false,
      isHashed: true,
    }
    if (newSalt) {
      pwStoreData.salt = newSalt
    }
    await this.stores.password.set(pwStoreData)
    await this.stores.password.setPlaintextPassword(newPw)
    return result.val
  }

  private async checkPassword({ password }: RequestTypes["pri(app.checkPassword)"]) {
    await this.stores.password.checkPassword(password)
    return true
  }

  private async resetWallet() {
    // delete all the accounts
    keyring.getAccounts().forEach((acc) => keyring.forgetAccount(acc.address))
    this.stores.app.set({ onboarded: "FALSE" })
    await this.stores.password.reset()
    await this.stores.seedPhrase.clear()
    await windowManager.openOnboarding("/import?resetWallet=true")
    // since all accounts are being wiped, all sites need to be reset - so they may as well be wiped.
    await this.stores.sites.clear()

    return true
  }

  private async dashboardOpen({ route }: RequestRoute): Promise<boolean> {
    if (!(await this.stores.app.getIsOnboarded())) return this.onboardOpen()
    windowManager.openDashboard({ route })
    return true
  }

  private async openSendFunds({ from, tokenId, to }: SendFundsOpenRequest): Promise<boolean> {
    const params = new URLSearchParams()
    if (from) params.append("from", from)
    if (tokenId) params.append("tokenId", tokenId)
    if (to) params.append("to", to)
    await windowManager.popupOpen(`#/send?${params.toString()}`)

    return true
  }

  private async openModal(request: ModalOpenRequest): Promise<void> {
    const queryUrl = Browser.runtime.getURL("dashboard.html")
    const [tab] = await Browser.tabs.query({ url: queryUrl })
    if (!tab) {
      await windowManager.openDashboard({ route: "/portfolio" })
      // wait for newly created page to load and subscribe to backend (max 5 seconds)
      for (let i = 0; i < 50 && !this.#modalOpenRequest.observed; i++) await sleep(100)
    }
    this.#modalOpenRequest.next(request)
  }

  private onboardOpen(): boolean {
    windowManager.openOnboarding()
    return true
  }

  private popupOpen(): boolean {
    // TODO does absolutely nothing ???
    return true
  }

  private promptLogin(closeOnSuccess: boolean): boolean {
    windowManager.popupOpen(`?closeOnSuccess=${closeOnSuccess}`)
    return true
  }

  public async handle<TMessageType extends MessageTypes>(
    id: string,
    type: TMessageType,
    request: RequestTypes[TMessageType],
    port: Port
  ): Promise<ResponseType<TMessageType>> {
    switch (type) {
      // --------------------------------------------------------------------
      // app handlers -------------------------------------------------------
      // --------------------------------------------------------------------
      case "pri(app.onboard)":
        return this.onboard(request as RequestOnboard)

      case "pri(app.onboardStatus)":
        return await this.stores.app.get("onboarded")

      case "pri(app.onboardStatus.subscribe)":
        return genericSubscription(
          id,
          port,
          this.stores.app.observable,
          ({ onboarded }: AppStoreData) => onboarded
        )

      case "pri(app.authenticate)":
        return this.authenticate(request as RequestLogin)

      case "pri(app.authStatus)":
        return this.authStatus()

      case "pri(app.authStatus.subscribe)":
        return genericSubscription<"pri(app.authStatus.subscribe)">(
          id,
          port,
          this.stores.password.isLoggedIn
        )

      case "pri(app.lock)":
        return this.lock()

      case "pri(app.changePassword)":
        return await this.changePassword(request as RequestTypes["pri(app.changePassword)"])

      case "pri(app.checkPassword)":
        return await this.checkPassword(request as RequestTypes["pri(app.checkPassword)"])

      case "pri(app.dashboardOpen)":
        return await this.dashboardOpen(request as RequestRoute)

      case "pri(app.onboardOpen)":
        return this.onboardOpen()

      case "pri(app.popupOpen)":
        return this.popupOpen()

      case "pri(app.promptLogin)":
        return this.promptLogin(request as boolean)

      case "pri(app.modalOpen.request)":
        return this.openModal(request as ModalOpenRequest)

      case "pri(app.sendFunds.open)":
        return this.openSendFunds(request as RequestTypes["pri(app.sendFunds.open)"])

      case "pri(app.modalOpen.subscribe)":
        return genericSubscription<"pri(app.modalOpen.subscribe)">(id, port, this.#modalOpenRequest)

      case "pri(app.analyticsCapture)": {
        const { eventName, options } = request as AnalyticsCaptureRequest
        talismanAnalytics.capture(eventName, options)
        return true
      }

      case "pri(app.phishing.addException)": {
        return protector.addException(
          (request as RequestTypes["pri(app.phishing.addException)"]).url
        )
      }

      case "pri(app.resetWallet)":
        return this.resetWallet()

      case "pri(app.requests)":
        return requestStore.subscribe(id, port)

      default:
        throw new Error(`Unable to handle message of type ${type}`)
    }
  }
}
