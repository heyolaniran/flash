/**
 * ENG-350 regression matrix — every Bridge transfer state in one fast unit suite.
 *
 * Validates transferHandler routing and side effects (DB update, notification, lock)
 * without MongoDB. Complements transfer-webhook-e2e.spec.ts.
 */

jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  BRIDGE_WITHDRAWAL_NOT_FOUND: "Withdrawal not found",
  updateWithdrawalStatus: jest.fn(),
}))

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
}))

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { sendBridgeWithdrawalNotificationBestEffort } from "@app/bridge/send-withdrawal-notification"
import { transferHandler } from "@services/bridge/webhook-server/routes/transfer"
import {
  BRIDGE_TRANSFER_STATE_SAMPLES,
  BridgeTransferStateSampleKey,
} from "test/flash/fixtures/bridge-transfer-state-samples"

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) => ({ body }) as unknown as Request

const WITHDRAWAL_RECORD = {
  id: "wd-regression",
  status: "pending",
  bridgeTransferId: "tr-regression",
  accountId: "acct-regression",
  amount: "100.00",
  currency: "usdt",
}

const updateFn = BridgeAccountsRepo.updateWithdrawalStatus as jest.Mock
let lockFn: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  lockFn = jest.fn().mockResolvedValue({})
  ;(LockService as jest.Mock).mockReturnValue({ lockIdempotencyKey: lockFn })
  updateFn.mockImplementation(async (_id: string, status: string, failureReason?: string) => ({
    ...WITHDRAWAL_RECORD,
    status,
    failureReason,
  }))
})

describe("ENG-350 transfer webhook regression matrix", () => {
  const entries = Object.entries(BRIDGE_TRANSFER_STATE_SAMPLES) as Array<
    [BridgeTransferStateSampleKey, (typeof BRIDGE_TRANSFER_STATE_SAMPLES)[BridgeTransferStateSampleKey]]
  >

  it.each(entries)("%s — %s", async (_stateKey, sample) => {
    const transferId = "tr-regression-matrix"
    const res = makeRes()

    await transferHandler(
      makeReq({
        event: sample.event,
        data: { ...sample.data, transfer_id: transferId },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)

    const jsonStatus = (res.json as jest.Mock).mock.calls[0][0].status

    switch (sample.expectedHandlerOutcome) {
      case "ignored":
        expect(jsonStatus).toBe("ignored")
        expect(updateFn).not.toHaveBeenCalled()
        expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
        expect(lockFn).not.toHaveBeenCalled()
        break
      case "ignored_transient_state":
        expect(jsonStatus).toBe("ignored_transient_state")
        expect(updateFn).not.toHaveBeenCalled()
        expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
        expect(lockFn).not.toHaveBeenCalled()
        break
      case "completed":
        expect(jsonStatus).toBe("success")
        expect(updateFn).toHaveBeenCalledWith(transferId, "completed")
        expect(lockFn).toHaveBeenCalledWith(
          `bridge-transfer:${transferId}:${sample.event}:${sample.data.state}`,
        )
        expect(sendBridgeWithdrawalNotificationBestEffort).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "completed" }),
        )
        break
      case "failed": {
        expect(jsonStatus).toBe("success")
        const expectedReason =
          sample.data.state === "refund_failed"
            ? (sample.data as { return_reason?: string }).return_reason
            : (sample.data as { reason?: string }).reason
        expect(updateFn).toHaveBeenCalledWith(transferId, "failed", expectedReason)
        expect(sendBridgeWithdrawalNotificationBestEffort).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: "failed",
            failureReason: expectedReason,
          }),
        )
        break
      }
      default:
        throw new Error(`Unhandled expectedHandlerOutcome: ${sample.expectedHandlerOutcome}`)
    }
  })

  it("transfer.failed event with terminal failure state resets withdrawal (ENG-350 AC)", async () => {
    const transferId = "tr-failed-event"
    const reason = "R03 - No account/unable to locate account"
    const res = makeRes()

    await transferHandler(
      makeReq({
        event: "transfer.failed",
        data: {
          transfer_id: transferId,
          state: "returned",
          amount: "100.00",
          currency: "usdt",
          reason,
        },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect(updateFn).toHaveBeenCalledWith(transferId, "failed", reason)
    expect(sendBridgeWithdrawalNotificationBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed", failureReason: reason }),
    )
    // No ledger/credit-back path — only repo + notification
    expect(lockFn).toHaveBeenCalled()
  })
})
