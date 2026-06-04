import {
  isOutboundBridgeWithdrawal,
  transferReplayEventTypeForStatus,
} from "@services/bridge/webhook-server/transfer-direction"

describe("transfer-direction (ENG-350 replay routing)", () => {
  const outboundWithdrawal = {
    id: "tr-out",
    state: "payment_processed",
    source: { payment_rail: "ethereum", currency: "usdt" },
    destination: { payment_rail: "ach", currency: "usd" },
  }

  const inboundDeposit = {
    id: "tr-in",
    state: "payment_processed",
    source: { payment_rail: "ach", currency: "usd" },
    destination: { payment_rail: "ethereum", currency: "usdt" },
  }

  describe("isOutboundBridgeWithdrawal", () => {
    it("returns true for USDT ethereum → ACH usd", () => {
      expect(isOutboundBridgeWithdrawal(outboundWithdrawal)).toBe(true)
    })

    it("returns false for inbound deposit direction", () => {
      expect(isOutboundBridgeWithdrawal(inboundDeposit)).toBe(false)
    })

    it("returns false when event object is missing", () => {
      expect(isOutboundBridgeWithdrawal(undefined)).toBe(false)
    })
  })

  describe("transferReplayEventTypeForStatus", () => {
    it("maps payment_processed to transfer.payment_processed", () => {
      expect(transferReplayEventTypeForStatus("payment_processed")).toBe(
        "transfer.payment_processed",
      )
    })

    it.each([
      "undeliverable",
      "returned",
      "refunded",
      "refund_failed",
      "missing_return_policy",
      "error",
      "canceled",
    ])("maps terminal failure %s to transfer.failed", (status) => {
      expect(transferReplayEventTypeForStatus(status)).toBe("transfer.failed")
    })

    it("returns null for non-terminal intermediate states", () => {
      expect(transferReplayEventTypeForStatus("awaiting_funds")).toBeNull()
      expect(transferReplayEventTypeForStatus("refund_in_flight")).toBeNull()
    })
  })
})
