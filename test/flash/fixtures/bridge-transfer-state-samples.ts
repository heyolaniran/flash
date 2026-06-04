/**
 * Bridge transfer webhook state samples for ENG-350 regression tests.
 *
 * Source: https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer-states
 */
export const BRIDGE_TRANSFER_STATE_SAMPLES = {
  awaiting_funds: {
    event: "transfer.updated",
    data: {
      transfer_id: "trx_awaiting_funds_sample",
      state: "awaiting_funds",
      amount: "100.00",
      currency: "usdt",
    },
    description: "Bridge is waiting to receive funds from the customer",
    expectedHandlerOutcome: "ignored",
  },

  in_review: {
    event: "transfer.updated",
    data: {
      transfer_id: "trx_in_review_sample",
      state: "in_review",
      amount: "100.00",
      currency: "usdt",
    },
    description:
      "Temporary compliance hold; typically resolves quickly or Bridge contacts within 24h",
    expectedHandlerOutcome: "ignored",
  },

  funds_received: {
    event: "transfer.updated",
    data: {
      transfer_id: "trx_funds_received_sample",
      state: "funds_received",
      amount: "100.00",
      currency: "usdt",
    },
    description: "Bridge has received funds and is preparing to move them",
    expectedHandlerOutcome: "ignored",
  },

  payment_submitted: {
    event: "transfer.updated",
    data: {
      transfer_id: "trx_payment_submitted_sample",
      state: "payment_submitted",
      amount: "100.00",
      currency: "usdt",
    },
    description:
      "Payment submitted; tx hash may be preliminary — use payment_processed hash",
    expectedHandlerOutcome: "ignored",
  },

  payment_processed: {
    event: "transfer.completed",
    data: {
      transfer_id: "trx_payment_processed_sample",
      state: "payment_processed",
      amount: "100.00",
      currency: "usdt",
    },
    description: "Transfer complete — funds successfully delivered to destination",
    expectedHandlerOutcome: "completed",
  },

  undeliverable: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_undeliverable_sample",
      state: "undeliverable",
      amount: "100.00",
      currency: "usdt",
      reason: "Invalid destination bank account number",
    },
    description: "Unable to deliver — invalid account or unsupported asset",
    expectedHandlerOutcome: "failed",
  },

  returned: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_returned_sample",
      state: "returned",
      amount: "100.00",
      currency: "usdt",
      reason: "R03 - No account/unable to locate account",
    },
    description: "Payment failed; funds returning to Bridge for refund processing",
    expectedHandlerOutcome: "failed",
  },

  refund_in_flight: {
    event: "transfer.updated",
    data: {
      transfer_id: "trx_refund_in_flight_sample",
      state: "refund_in_flight",
      amount: "100.00",
      currency: "usdt",
    },
    description: "Transient: refund initiated and in progress — awaiting terminal event",
    expectedHandlerOutcome: "ignored_transient_state",
  },

  missing_return_policy: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_missing_return_policy_sample",
      state: "missing_return_policy",
      amount: "100.00",
      currency: "usdt",
      reason: "Crypto return policy configuration required before returning deposit",
    },
    description: "Crypto return policy configuration required",
    expectedHandlerOutcome: "failed",
  },

  refunded: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_refunded_sample",
      state: "refunded",
      amount: "100.00",
      currency: "usdt",
      reason: "Payment reversed by receiving institution",
    },
    description: "Refunded — Bridge no longer has the funds",
    expectedHandlerOutcome: "failed",
  },

  refund_failed: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_refund_failed_sample",
      state: "refund_failed",
      amount: "100.00",
      currency: "usdt",
      return_reason: "Account closed or suspended — unable to return funds",
    },
    description: "Refund attempt unsuccessful (closed/suspended bank account)",
    expectedHandlerOutcome: "failed",
  },

  error: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_error_sample",
      state: "error",
      amount: "100.00",
      currency: "usdt",
      reason: "Internal processing error — requires manual review",
    },
    description: "Problem blocking processing; requires manual review or developer action",
    expectedHandlerOutcome: "failed",
  },

  canceled: {
    event: "transfer.updated.status_transitioned",
    data: {
      transfer_id: "trx_canceled_sample",
      state: "canceled",
      amount: "100.00",
      currency: "usdt",
      reason: "Transfer canceled by customer before funds were received",
    },
    description: "Transfer canceled — can only happen from awaiting_funds state",
    expectedHandlerOutcome: "failed",
  },
} as const

export type BridgeTransferStateSampleKey = keyof typeof BRIDGE_TRANSFER_STATE_SAMPLES

export type BridgeTransferExpectedOutcome =
  (typeof BRIDGE_TRANSFER_STATE_SAMPLES)[BridgeTransferStateSampleKey]["expectedHandlerOutcome"]
