/**
 * E2E integration tests for Bridge transfer replay (ENG-350 ops recovery path).
 *
 * Exercises replayHandler → transferHandler with a real MongoDB instance so that
 * withdrawal updates and BridgeReplay audit logs persist correctly.
 *
 * Run:
 *   npx jest --config test/flash/integration/jest.bridge.config.js \
 *     --testPathPattern=transfer-replay-e2e
 */

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
        name: "bridge-replay-e2e-wallet",
        currencyId: 3,
        balance: 0,
      })),
      getIbexCurrencyId: jest.fn(),
      createLnurlPay: jest.fn().mockResolvedValue({ lnurl: "lnurl-replay-e2e-mock" }),
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

import crypto from "crypto"
import { Request, Response } from "express"
import mongoose from "mongoose"
import { setupMongoConnection } from "@services/mongodb"
import { AccountsRepository } from "@services/mongoose/accounts"
import { BridgeWithdrawal, BridgeReplay } from "@services/mongoose/schema"
import { createWithdrawal } from "@services/mongoose/bridge-accounts"
import {
  replayAuthMiddleware,
  replayHandler,
} from "@services/bridge/webhook-server/routes/replay"
import { LockService } from "@services/lock"
import {
  PushNotificationsService,
  SendFilteredPushNotificationStatus,
} from "@services/notifications/push-notifications"
import { getDefaultAccountsConfig } from "@config"
import { createAccountWithPhoneIdentifier } from "@app/accounts/create-account"
import { randomPhone, randomUserId } from "test/galoy/helpers"
import { AccountLevel } from "@domain/accounts/primitives"
import { toBridgeCustomerId } from "@domain/primitives/bridge"

const REPLAY_SECRET = "e2e-replay-secret-token-eng350"

process.env.BRIDGE_WEBHOOK_REPLAY_SECRET = REPLAY_SECRET

const uniqueTransferId = () => `trx_replay_${crypto.randomBytes(6).toString("hex")}`

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReplayReq = (body: Record<string, unknown>) =>
  ({
    body,
    headers: { authorization: `Bearer ${REPLAY_SECRET}` },
  }) as unknown as Request

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

  const repo = AccountsRepository()

  const leveled = await repo.update({ ...account, level: AccountLevel.Two })
  if (leveled instanceof Error) throw leveled

  const updated = await repo.updateBridgeFields(account.id, {
    bridgeCustomerId: toBridgeCustomerId("cust_replay_e2e"),
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

describe("Bridge transfer replay E2E (ENG-350)", () => {
  describe("replayAuthMiddleware", () => {
    it("rejects requests without a valid Bearer token", () => {
      const res = makeRes()
      const next = jest.fn()
      replayAuthMiddleware({ headers: {}, body: {} } as Request, res, next)
      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe("outbound withdrawal replay → transferHandler", () => {
    it("replays status_transitioned payment_processed and completes the withdrawal", async () => {
      const transferId = uniqueTransferId()
      const record = await createWithdrawal({
        accountId,
        bridgeTransferId: transferId,
        amount: "75.00",
        currency: "usdt",
        externalAccountId: `ext_replay_${crypto.randomBytes(4).toString("hex")}`,
        status: "pending",
      })
      if (record instanceof Error) throw record

      const eventId = `evt_replay_${crypto.randomBytes(4).toString("hex")}`
      const res = makeRes()

      await replayHandler(
        makeReplayReq({
          event_id: eventId,
          event_type: "updated.status_transitioned",
          event_object_status: "payment_processed",
          event_object: {
            id: transferId,
            transfer_id: transferId,
            state: "payment_processed",
            amount: "75.00",
            currency: "usdt",
            source: { payment_rail: "ethereum", currency: "usdt" },
            destination: { payment_rail: "ach", currency: "usd" },
          },
          event_created_at: "2026-06-04T12:00:00Z",
          operator: "ops-replay-e2e@flash.test",
          time_window_start: "2026-06-04T00:00:00Z",
          time_window_end: "2026-06-04T23:59:59Z",
        }),
        res,
      )

      expect(res.status).toHaveBeenCalledWith(200)
      const body = (res.json as jest.Mock).mock.calls[0][0]
      expect(body).toMatchObject({
        status: "replayed",
        handler_status: 200,
        handler_response: { status: "success" },
      })
      expect(body.log_id).toBeDefined()

      const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
      expect(doc?.status).toBe("completed")

      const replayLog = await BridgeReplay.findOne({ eventId }).lean()
      expect(replayLog).not.toBeNull()
      expect(replayLog?.operator).toBe("ops-replay-e2e@flash.test")
      expect(replayLog?.httpStatus).toBe(200)
      expect(replayLog?.dryRun).toBe(false)

      expect(mockSendFilteredNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: "bridge_withdrawal_completed" }),
        }),
      )
    })

    it("replays terminal failure (returned) and resets withdrawal with reason", async () => {
      const transferId = uniqueTransferId()
      const failureReason = "R03 - No account/unable to locate account"
      const record = await createWithdrawal({
        accountId,
        bridgeTransferId: transferId,
        amount: "100.00",
        currency: "usdt",
        externalAccountId: `ext_replay_fail_${crypto.randomBytes(4).toString("hex")}`,
        status: "pending",
      })
      if (record instanceof Error) throw record

      const res = makeRes()

      await replayHandler(
        makeReplayReq({
          event_type: "updated.status_transitioned",
          event_object_status: "returned",
          event_object: {
            id: transferId,
            transfer_id: transferId,
            state: "returned",
            amount: "100.00",
            currency: "usdt",
            reason: failureReason,
            source: { payment_rail: "ethereum", currency: "usdt" },
            destination: { payment_rail: "ach", currency: "usd" },
          },
          event_created_at: "2026-06-04T12:00:00Z",
          operator: "ops-replay-e2e@flash.test",
          time_window_start: "2026-06-04T00:00:00Z",
          time_window_end: "2026-06-04T23:59:59Z",
        }),
        res,
      )

      expect(res.status).toHaveBeenCalledWith(200)

      const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
      expect(doc?.status).toBe("failed")
      expect(doc?.failureReason).toBe(failureReason)

      expect(mockSendFilteredNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "bridge_withdrawal_failed",
            failureReason: failureReason,
          }),
        }),
      )
    })

    it("dry_run persists audit log without mutating withdrawal", async () => {
      const transferId = uniqueTransferId()
      const record = await createWithdrawal({
        accountId,
        bridgeTransferId: transferId,
        amount: "50.00",
        currency: "usdt",
        externalAccountId: `ext_replay_dry_${crypto.randomBytes(4).toString("hex")}`,
        status: "pending",
      })
      if (record instanceof Error) throw record

      const eventId = `evt_dry_${crypto.randomBytes(4).toString("hex")}`
      const res = makeRes()

      await replayHandler(
        makeReplayReq({
          event_id: eventId,
          event_type: "transfer.completed",
          event_object: {
            transfer_id: transferId,
            state: "payment_processed",
            amount: "50.00",
            currency: "usdt",
          },
          event_created_at: "2026-06-04T12:00:00Z",
          operator: "ops-dry-run@flash.test",
          time_window_start: "2026-06-04T00:00:00Z",
          time_window_end: "2026-06-04T23:59:59Z",
          dry_run: true,
        }),
        res,
      )

      expect(res.status).toHaveBeenCalledWith(200)

      const doc = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId }).lean()
      expect(doc?.status).toBe("pending")
      expect(mockSendFilteredNotification).not.toHaveBeenCalled()

      const replayLog = await BridgeReplay.findOne({ eventId }).lean()
      expect(replayLog?.dryRun).toBe(true)
      expect(replayLog?.httpStatus).toBe(0)
    })
  })
})
