/**
 * E2E integration tests for the Bridge transfer webhook handler (ENG-350).
 *
 * Covers every transfer state from https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer-states
 * and validates the full pipeline: HTTP layer → DB update → device push notification.
 *
 * Uses a real MongoDB instance so that Mongoose transitions and index constraints
 * are exercised against actual DB behaviour.
 *
 * External I/O mocked:
 *   - LockService              (needs Redis)
 *   - PushNotificationsService (real push infrastructure)
 *   - removeDeviceTokens       (cleanup side-effect)
 *   - @services/logger
 *   - @services/tracing
 *
 * Run:
 *   npx jest --config test/flash/integration/jest.config.js \
 *     --testPathPattern=transfer-webhook-e2e
 */

// ── Mocks (hoisted before any import) ────────────────────────────────────────

jest.mock("@app/prices/get-current-price", () =>
  require("test/flash/mocks/get-current-price"),
)

jest.mock("@services/ibex/client", () => {
  const crypto = require("crypto")
  return {
    __esModule: true,
    default: {
      createAccount: jest.fn().mockImplementation(async () => ({
        id: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        name: "bridge-e2e-wallet",
        currencyId: 3,
        balance: 0,
      })),
      getIbexCurrencyId: jest.fn(),
      createLnurlPay: jest.fn().mockResolvedValue({ lnurl: "lnurl-e2e-mock" }),
    },
  }
})

jest.mock("@services/tracing", () => ({
  wrapAsyncFunctionsToRunInSpan: ({
    fns,
  }: {
    namespace: string
    fns: Record<string, (...args: unknown[]) => unknown>
  }) => fns,
  wrapAsyncToRunInSpan: ({ fn }: { fn: (...args: unknown[]) => unknown }) => fn,
  recordExceptionInCurrentSpan: jest.fn(),
  addAttributesToCurrentSpan: jest.fn(),
}))

jest.mock("@services/logger", () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  }
  return { baseLogger: mockLogger }
})

jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

jest.mock("@services/notifications/push-notifications", () => ({
  PushNotificationsService: jest.fn(),
  SendFilteredPushNotificationStatus: { Sent: "Sent", Filtered: "Filtered" },
}))

jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: jest.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import crypto from "crypto"
import { Request, Response } from "express"
import mongoose from "mongoose"
import { setupMongoConnection } from "@services/mongodb"
import { AccountsRepository } from "@services/mongoose/accounts"
import { BridgeWithdrawal } from "@services/mongoose/schema"
import { createWithdrawal } from "@services/mongoose/bridge-accounts"
import { transferHandler } from "@services/bridge/webhook-server/routes/transfer"
import { LockService } from "@services/lock"
import {
  PushNotificationsService,
  SendFilteredPushNotificationStatus,
} from "@services/notifications/push-notifications"
import { getDefaultAccountsConfig } from "@config"
import { createAccountWithPhoneIdentifier } from "@app/accounts/create-account"
import { randomPhone, randomUserId } from "test/galoy/helpers"
import { AccountLevel } from "@domain/accounts/primitives"
import { toBridgeCustomerId, type BridgeTransferId } from "@domain/primitives/bridge"
import {
  BRIDGE_TRANSFER_STATE_SAMPLES,
  BridgeTransferStateSampleKey,
} from "test/flash/fixtures/bridge-transfer-state-samples"

// ── Helpers ───────────────────────────────────────────────────────────────────

const uniqueTransferId = () =>
  `trx_e2e_${crypto.randomBytes(6).toString("hex")}` as BridgeTransferId

const makeReq = (body: Record<string, unknown>) => ({ body } as unknown as Request)

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makePendingWithdrawal = async (
  accountId: string,
  transferId: string,
  overrides: {
    amount?: string
    currency?: string
  } = {},
) => {
  const record = await createWithdrawal({
    accountId,
    bridgeTransferId: transferId,
    amount: overrides.amount ?? "100.00",
    currency: overrides.currency ?? "usdt",
    externalAccountId: `ext_e2e_${crypto.randomBytes(4).toString("hex")}`,
    status: "pending",
  })
  if (record instanceof Error) throw record
  return record
}

// ── Connection & account setup ────────────────────────────────────────────────

let mongoConnection: typeof mongoose
let accountId: string

const mockSendFilteredNotification = jest.fn()

beforeAll(async () => {
  mongoConnection = await setupMongoConnection(true)

  const phone = randomPhone()
  const kratosUserId = randomUserId()
  const account = await createAccountWithPhoneIdentifier({
    newAccountInfo: { phone, kratosUserId },
    config: getDefaultAccountsConfig(),
  })
  if (account instanceof Error) throw account

  const { UsersRepository } = await import("@services/mongoose/users")
  await UsersRepository().update({
    id: kratosUserId,
    deviceTokens: [`token-${kratosUserId}`] as DeviceToken[],
  })

  const repo = AccountsRepository()

  const leveled = await repo.update({ ...account, level: AccountLevel.Two })
  if (leveled instanceof Error) throw leveled

  const updated = await repo.updateBridgeFields(account.id, {
    bridgeCustomerId: toBridgeCustomerId("cust_transfer_e2e"),
    bridgeKycStatus: "approved",
  })
  if (updated instanceof Error) throw updated

  accountId = String(account.id)
})

afterAll(async () => {
  if (mongoConnection) await mongoConnection.connection.close()
})

beforeEach(() => {
  jest.clearAllMocks()

  ;(LockService as jest.Mock).mockReturnValue({
    lockIdempotencyKey: jest.fn().mockResolvedValue({}),
  })

  ;(PushNotificationsService as jest.Mock).mockReturnValue({
    sendFilteredNotification: mockSendFilteredNotification.mockResolvedValue({
      status: SendFilteredPushNotificationStatus.Sent,
    }),
  })
})

// ── Group 1: Happy path — transfer completion states ──────────────────────────

describe("Happy path — payment_processed completion", () => {
  it("transfer.completed event: updates withdrawal to completed and sends success notification", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.completed",
      data: {
        transfer_id: transferId,
        state: "payment_processed",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "success" })

    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc).not.toBeNull()
    expect(doc?.status).toBe("completed")

    expect(mockSendFilteredNotification).toHaveBeenCalledTimes(1)
    expect(mockSendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "bridge_withdrawal_completed",
          amount: "100.00",
          currency: "USD",
        }),
      }),
    )
  })

  it("transfer.payment_processed event: updates withdrawal to completed and sends success notification", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.payment_processed",
      data: {
        transfer_id: transferId,
        state: "payment_processed",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)

    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.status).toBe("completed")

    expect(mockSendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "bridge_withdrawal_completed" }),
      }),
    )
  })

  it("state-only payment_processed (any event name): completion is detected by state", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.state_transition",
      data: {
        transfer_id: transferId,
        state: "payment_processed",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.status).toBe("completed")
  })
})

// ── Group 2: Failure / terminal states ───────────────────────────────────────

describe("Terminal failure states — withdrawal reset + failure notification", () => {
  const failureCases: Array<{
    label: string
    state: string
    event: string
    reason?: string
    return_reason?: string
    expectedReason?: string
  }> = [
    {
      label: "undeliverable — invalid destination account",
      state: "undeliverable",
      event: "transfer.updated.status_transitioned",
      reason: "Invalid destination bank account number",
      expectedReason: "Invalid destination bank account number",
    },
    {
      label: "returned — ACH return code R03",
      state: "returned",
      event: "transfer.updated.status_transitioned",
      reason: "R03 - No account/unable to locate account",
      expectedReason: "R03 - No account/unable to locate account",
    },
    {
      label: "refunded — payment reversed by institution",
      state: "refunded",
      event: "transfer.updated.status_transitioned",
      reason: "Payment reversed by receiving institution",
      expectedReason: "Payment reversed by receiving institution",
    },
    {
      label: "refund_failed — uses return_reason field",
      state: "refund_failed",
      event: "transfer.updated.status_transitioned",
      return_reason: "Account closed or suspended — unable to return funds",
      expectedReason: "Account closed or suspended — unable to return funds",
    },
    {
      label: "missing_return_policy — crypto return policy not configured",
      state: "missing_return_policy",
      event: "transfer.updated.status_transitioned",
      reason: "Crypto return policy configuration required",
      expectedReason: "Crypto return policy configuration required",
    },
    {
      label: "error — internal processing error",
      state: "error",
      event: "transfer.updated.status_transitioned",
      reason: "Internal processing error — requires manual review",
      expectedReason: "Internal processing error — requires manual review",
    },
    {
      label: "canceled — customer canceled before funds received",
      state: "canceled",
      event: "transfer.updated.status_transitioned",
      reason: "Transfer canceled by customer",
      expectedReason: "Transfer canceled by customer",
    },
    {
      label: "status_transitioned without specific state reason",
      state: "returned",
      event: "transfer.updated.status_transitioned",
      reason: "ACH return",
      expectedReason: "ACH return",
    },
  ]

  for (const tc of failureCases) {
    it(`${tc.label}: updates withdrawal to failed and sends failure notification`, async () => {
      const transferId = uniqueTransferId()
      await makePendingWithdrawal(accountId, transferId)

      const data: Record<string, unknown> = {
        transfer_id: transferId,
        state: tc.state,
        amount: "100.00",
        currency: "usdt",
      }
      if (tc.reason) data.reason = tc.reason
      if (tc.return_reason) data.return_reason = tc.return_reason

      const req = makeReq({ event: tc.event, data })
      const res = makeRes()

      await transferHandler(req, res)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "success" })

      const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
      expect(doc).not.toBeNull()
      expect(doc?.status).toBe("failed")

      if (tc.expectedReason) {
        expect(doc?.failureReason).toBe(tc.expectedReason)
      }

      expect(mockSendFilteredNotification).toHaveBeenCalledTimes(1)
      expect(mockSendFilteredNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "bridge_withdrawal_failed",
            amount: "100.00",
            currency: "USD",
          }),
        }),
      )
    })
  }

  it("failure reason is persisted and surfaced in notification data", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)
    const specificReason = "R07 - Authorization revoked by customer"

    const req = makeReq({
      event: "transfer.updated.status_transitioned",
      data: {
        transfer_id: transferId,
        state: "returned",
        amount: "50.00",
        currency: "usdt",
        reason: specificReason,
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.failureReason).toBe(specificReason)

    const notifCall = mockSendFilteredNotification.mock.calls[0][0]
    expect(notifCall.data.failureReason).toBe(specificReason)
  })

  it("refund_failed uses return_reason over reason in both DB and notification", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.updated.status_transitioned",
      data: {
        transfer_id: transferId,
        state: "refund_failed",
        amount: "100.00",
        currency: "usdt",
        reason: "should be ignored for refund_failed",
        return_reason: "Destination account suspended",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.failureReason).toBe("Destination account suspended")
  })

  it("terminal state detected by state field regardless of event name", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.updated.status_transitioned",
      data: {
        transfer_id: transferId,
        state: "undeliverable",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.status).toBe("failed")
  })
})

// ── Group 3: Transient and intermediate states (ignored) ──────────────────────

describe("Transient / intermediate states — no DB change, no notification", () => {
  const ignoredCases: Array<{ label: string; state: string; event: string }> = [
    {
      label: "awaiting_funds — Bridge waiting for customer funds",
      state: "awaiting_funds",
      event: "transfer.updated",
    },
    {
      label: "in_review — compliance hold",
      state: "in_review",
      event: "transfer.updated",
    },
    {
      label: "funds_received — Bridge received funds, preparing movement",
      state: "funds_received",
      event: "transfer.updated",
    },
    {
      label: "payment_submitted — tx submitted, hash not yet final",
      state: "payment_submitted",
      event: "transfer.updated",
    },
    {
      label: "refund_in_flight — transient, awaiting terminal refund outcome",
      state: "refund_in_flight",
      event: "transfer.updated",
    },
  ]

  for (const tc of ignoredCases) {
    it(`${tc.label}: returns 200 and does not modify withdrawal or send notification`, async () => {
      const transferId = uniqueTransferId()
      await makePendingWithdrawal(accountId, transferId)

      const req = makeReq({
        event: tc.event,
        data: {
          transfer_id: transferId,
          state: tc.state,
          amount: "100.00",
          currency: "USD",
        },
      })
      const res = makeRes()

      await transferHandler(req, res)

      expect(res.status).toHaveBeenCalledWith(200)

      const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
      expect(doc?.status).toBe("pending")

      expect(mockSendFilteredNotification).not.toHaveBeenCalled()
    })
  }

  it("refund_in_flight explicitly returns ignored_transient_state status", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.updated",
      data: {
        transfer_id: transferId,
        state: "refund_in_flight",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.json).toHaveBeenCalledWith({ status: "ignored_transient_state" })
  })
})

// ── Group 4: Idempotency — duplicate webhook handling ────────────────────────

describe("Idempotency — duplicate webhooks are safe", () => {
  it("already_processed: lock already held skips notification and returns 200", async () => {
    ;(LockService as jest.Mock).mockReturnValue({
      lockIdempotencyKey: jest.fn().mockResolvedValue(new Error("already locked")),
    })

    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.completed",
      data: {
        transfer_id: transferId,
        state: "payment_processed",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
    expect(mockSendFilteredNotification).not.toHaveBeenCalled()
  })

  it("already_terminal: webhook for already-completed withdrawal is silently accepted", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const completionReq = makeReq({
      event: "transfer.completed",
      data: { transfer_id: transferId, state: "payment_processed", amount: "100.00", currency: "usdt" },
    })

    await transferHandler(completionReq, makeRes())
    jest.clearAllMocks()
    ;(LockService as jest.Mock).mockReturnValue({
      lockIdempotencyKey: jest.fn().mockResolvedValue({}),
    })
    ;(PushNotificationsService as jest.Mock).mockReturnValue({
      sendFilteredNotification: mockSendFilteredNotification.mockResolvedValue({
        status: SendFilteredPushNotificationStatus.Sent,
      }),
    })

    // Duplicate completion webhook
    const duplicateReq = makeReq({
      event: "transfer.completed",
      data: { transfer_id: transferId, state: "payment_processed", amount: "100.00", currency: "usdt" },
    })
    const duplicateRes = makeRes()

    await transferHandler(duplicateReq, duplicateRes)

    expect(duplicateRes.status).toHaveBeenCalledWith(200)
    expect(duplicateRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: expect.stringMatching(/already_processed|success/) }),
    )
  })

  it("already_terminal: failure after failure does not double-notify", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const failReq = () =>
      makeReq({
        event: "transfer.updated.status_transitioned",
        data: { transfer_id: transferId, state: "error", amount: "100.00", currency: "usdt" },
      })

    await transferHandler(failReq(), makeRes())
    jest.clearAllMocks()
    ;(LockService as jest.Mock).mockReturnValue({
      lockIdempotencyKey: jest.fn().mockResolvedValue({}),
    })
    ;(PushNotificationsService as jest.Mock).mockReturnValue({
      sendFilteredNotification: mockSendFilteredNotification,
    })

    const secondRes = makeRes()
    await transferHandler(failReq(), secondRes)

    expect(secondRes.status).toHaveBeenCalledWith(200)
    expect(secondRes.json).toHaveBeenCalledWith({ status: "already_terminal" })
    expect(mockSendFilteredNotification).not.toHaveBeenCalled()
  })
})

// ── Group 5: Error cases and edge conditions ──────────────────────────────────

describe("Error handling and edge conditions", () => {
  it("returns 400 when transfer_id is missing", async () => {
    const req = makeReq({
      event: "transfer.completed",
      data: { state: "payment_processed", amount: "100.00", currency: "usdt" },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid payload" })
  })

  it("returns 400 when event is missing", async () => {
    const req = makeReq({
      data: { transfer_id: uniqueTransferId(), state: "payment_processed" },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
  })

  it("returns 503 when withdrawal row not yet written (Bridge may retry)", async () => {
    const unknownTransferId = `trx_not_in_db_${crypto.randomBytes(6).toString("hex")}`

    const req = makeReq({
      event: "transfer.completed",
      data: {
        transfer_id: unknownTransferId,
        state: "payment_processed",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: "Withdrawal not ready" })
    expect(mockSendFilteredNotification).not.toHaveBeenCalled()
  })

  it("returns 503 for status_transitioned failure when withdrawal row not yet written", async () => {
    const unknownTransferId = `trx_fail_not_in_db_${crypto.randomBytes(6).toString("hex")}`

    const req = makeReq({
      event: "transfer.updated.status_transitioned",
      data: {
        transfer_id: unknownTransferId,
        state: "undeliverable",
        amount: "100.00",
        currency: "usdt",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: "Withdrawal not ready" })
  })

  it("IBEX balance is unaffected: withdrawal failure only updates bridge status, no credit-back", async () => {
    // ENG-350 AC: USDT was never debited until off-ramp settled.
    // The Flash/IBEX ledger is not touched by this handler — only the bridgeWithdrawals
    // Mongoose row changes. This test verifies the handler does not call any wallet/ledger ops.
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.updated.status_transitioned",
      data: {
        transfer_id: transferId,
        state: "returned",
        amount: "100.00",
        currency: "usdt",
        reason: "R03",
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)

    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.status).toBe("failed")
    // No wallet/ledger interaction — the only side effects are:
    // 1. bridgeWithdrawals row updated to failed
    // 2. Push notification dispatched to user
    expect(mockSendFilteredNotification).toHaveBeenCalledTimes(1)
  })
})

// ── Group 6: Notification payload — device token notification details ─────────

describe("Device token push notification — payload details", () => {
  it("completed notification carries correct notificationCategory (Cashout)", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId, { amount: "250.00", currency: "usdt" })

    const req = makeReq({
      event: "transfer.completed",
      data: { transfer_id: transferId, state: "payment_processed", amount: "250.00", currency: "usdt" },
    })

    await transferHandler(req, makeRes())

    const callArgs = mockSendFilteredNotification.mock.calls[0][0]
    expect(callArgs.notificationCategory).toBe("Cashout")
    expect(callArgs.data.type).toBe("bridge_withdrawal_completed")
    expect(callArgs.data.amount).toBe("250.00")
    expect(callArgs.data.currency).toBe("USD")
  })

  it("failed notification carries correct notificationCategory and failureReason", async () => {
    const transferId = uniqueTransferId()
    const reason = "R16 - Account frozen by order of legal process"
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.updated.status_transitioned",
      data: { transfer_id: transferId, state: "returned", amount: "100.00", currency: "usdt", reason },
    })

    await transferHandler(req, makeRes())

    const callArgs = mockSendFilteredNotification.mock.calls[0][0]
    expect(callArgs.notificationCategory).toBe("Cashout")
    expect(callArgs.data.type).toBe("bridge_withdrawal_failed")
    expect(callArgs.data.failureReason).toBe(reason)
  })

  it("notification is sent to the device tokens of the account owner", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.completed",
      data: { transfer_id: transferId, state: "payment_processed", amount: "100.00", currency: "usdt" },
    })

    await transferHandler(req, makeRes())

    const callArgs = mockSendFilteredNotification.mock.calls[0][0]
    // deviceTokens comes from UsersRepository — real user, may be empty in test env
    expect(callArgs).toHaveProperty("deviceTokens")
    expect(Array.isArray(callArgs.deviceTokens)).toBe(true)
    // notificationSettings comes from AccountsRepository
    expect(callArgs).toHaveProperty("notificationSettings")
  })

  it("notification is best-effort: handler still returns 200 even if push fails", async () => {
    ;(PushNotificationsService as jest.Mock).mockReturnValue({
      sendFilteredNotification: jest.fn().mockRejectedValue(new Error("Push service down")),
    })

    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: "transfer.completed",
      data: { transfer_id: transferId, state: "payment_processed", amount: "100.00", currency: "usdt" },
    })
    const res = makeRes()

    await transferHandler(req, res)

    // DB update should still complete
    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.status).toBe("completed")
  })
})

// ── Group 7: ENG-350 full regression matrix (all Bridge transfer states) ───────

describe("ENG-350 regression matrix — all Bridge transfer states against MongoDB", () => {
  const entries = Object.entries(BRIDGE_TRANSFER_STATE_SAMPLES) as Array<
    [BridgeTransferStateSampleKey, (typeof BRIDGE_TRANSFER_STATE_SAMPLES)[BridgeTransferStateSampleKey]]
  >

  it.each(entries)("%s — %s", async (_stateKey, sample) => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)

    const req = makeReq({
      event: sample.event,
      data: { ...sample.data, transfer_id: transferId },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)

    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    const jsonStatus = (res.json as jest.Mock).mock.calls[0][0].status

    switch (sample.expectedHandlerOutcome) {
      case "ignored":
      case "ignored_transient_state":
        expect(jsonStatus).toBe(sample.expectedHandlerOutcome)
        expect(doc?.status).toBe("pending")
        expect(mockSendFilteredNotification).not.toHaveBeenCalled()
        break
      case "completed":
        expect(jsonStatus).toBe("success")
        expect(doc?.status).toBe("completed")
        expect(mockSendFilteredNotification).toHaveBeenCalledTimes(1)
        expect(mockSendFilteredNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ type: "bridge_withdrawal_completed" }),
          }),
        )
        break
      case "failed":
        expect(jsonStatus).toBe("success")
        expect(doc?.status).toBe("failed")
        expect(mockSendFilteredNotification).toHaveBeenCalledTimes(1)
        expect(mockSendFilteredNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ type: "bridge_withdrawal_failed" }),
          }),
        )
        if (sample.data.state === "refund_failed") {
          expect(doc?.failureReason).toBe(
            (sample.data as { return_reason?: string }).return_reason,
          )
        } else if ((sample.data as { reason?: string }).reason) {
          expect(doc?.failureReason).toBe((sample.data as { reason?: string }).reason)
        }
        break
      default:
        throw new Error(`Unhandled outcome: ${sample.expectedHandlerOutcome}`)
    }
  })

  it("transfer.failed event: resets pending row and surfaces failure reason (ENG-350 AC)", async () => {
    const transferId = uniqueTransferId()
    await makePendingWithdrawal(accountId, transferId)
    const reason = "R07 - Authorization revoked by customer"

    const req = makeReq({
      event: "transfer.failed",
      data: {
        transfer_id: transferId,
        state: "returned",
        amount: "100.00",
        currency: "usdt",
        reason,
      },
    })
    const res = makeRes()

    await transferHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
    expect(doc?.status).toBe("failed")
    expect(doc?.failureReason).toBe(reason)
    expect(mockSendFilteredNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "bridge_withdrawal_failed",
          failureReason: reason,
        }),
      }),
    )
  })
})
