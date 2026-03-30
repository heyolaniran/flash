# Implementation Guide: Top-Up Notification Feature

## Quick Reference: Implementation Steps

This document provides detailed code snippets for implementing the top-up notification feature.

---

## Step 1: Update Domain Notification Types

### File: `src/domain/notifications/index.ts`

**Add to NotificationType enum:**

```typescript
export const NotificationType = {
  IntraLedgerReceipt: "intra_ledger_receipt",
  IntraLedgerPayment: "intra_ledger_payment",
  OnchainReceipt: "onchain_receipt",
  OnchainReceiptPending: "onchain_receipt_pending",
  OnchainPayment: "onchain_payment",
  LnInvoicePaid: "paid-invoice",
  TopupInitiated: "topup_initiated",        // ← NEW
  TopupCompleted: "topup_completed",        // ← NEW
} as const
```

---

## Step 2: Update TypeScript Interface Types

### File: `src/domain/notifications/index.types.d.ts`

**Add after existing type definitions:**

```typescript
// ===== TOPUP NOTIFICATION TYPES =====

/**
 * Arguments for sending a topup initiated notification
 * Sent when payment webhook is received and validated
 */
type TopupInitiatedArgs = TransactionReceivedNotificationBaseArgs & {
  paymentProvider: "fygaro" | "stripe" | "paypal" | string
  transactionId: string
}

/**
 * Arguments for sending a topup completed notification
 * Sent after payment is successfully credited to wallet
 */
type TopupCompletedArgs = TransactionReceivedNotificationBaseArgs & {
  transactionId: string
}
```

**Update INotificationsService interface:**

```typescript
interface INotificationsService {
  // ... existing methods ...

  /**
   * Send notification when topup payment is initiated
   * Called immediately after webhook validation, before processing
   */
  topupInitiated(
    args: TopupInitiatedArgs,
  ): Promise<true | NotificationsServiceError>

  /**
   * Send notification when topup payment is successfully completed
   * Called after payment is credited to user's wallet
   */
  topupCompleted(
    args: TopupCompletedArgs,
  ): Promise<true | NotificationsServiceError>
}
```

---

## Step 3: Implement Notification Methods

### File: `src/services/notifications/index.ts`

**Add the following methods inside the NotificationsService function:**

```typescript
const topupInitiated = async ({
  recipientAccountId,
  recipientWalletId,
  paymentAmount,
  displayPaymentAmount,
  recipientDeviceTokens,
  recipientNotificationSettings,
  recipientLanguage,
  paymentProvider,
  transactionId,
}: TopupInitiatedArgs): Promise<true | NotificationsServiceError> => {
  try {
    if (!recipientDeviceTokens || recipientDeviceTokens.length === 0) {
      return true
    }

    const notificationCategory = GaloyNotificationCategories.Payments

    const { title, body } = createPushNotificationContent({
      type: NotificationType.TopupInitiated,
      userLanguage: recipientLanguage,
      amount: paymentAmount,
      displayAmount: displayPaymentAmount,
    })

    const result = await pushNotification.sendFilteredNotification({
      deviceTokens: recipientDeviceTokens,
      title,
      body,
      notificationCategory,
      notificationSettings: recipientNotificationSettings,
      data: {
        transactionId,
        paymentProvider,
        type: "topup_initiated",
      },
    })

    if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
      await removeDeviceTokens({
        userId: recipientUser.id,
        deviceTokens: result.tokens,
      })
    } else if (result instanceof NotificationsServiceError) {
      logger.error(result, "Failed to send topup initiated notification")
      // Don't block - return true to continue processing
    }

    return true
  } catch (err) {
    return handleCommonNotificationErrors(err)
  }
}

const topupCompleted = async ({
  recipientAccountId,
  recipientWalletId,
  paymentAmount,
  displayPaymentAmount,
  recipientDeviceTokens,
  recipientNotificationSettings,
  recipientLanguage,
  transactionId,
}: TopupCompletedArgs): Promise<true | NotificationsServiceError> => {
  try {
    if (!recipientDeviceTokens || recipientDeviceTokens.length === 0) {
      return true
    }

    const notificationCategory = GaloyNotificationCategories.Payments

    const { title, body } = createPushNotificationContent({
      type: NotificationType.TopupCompleted,
      userLanguage: recipientLanguage,
      amount: paymentAmount,
      displayAmount: displayPaymentAmount,
    })

    const result = await pushNotification.sendFilteredNotification({
      deviceTokens: recipientDeviceTokens,
      title,
      body,
      notificationCategory,
      notificationSettings: recipientNotificationSettings,
      data: {
        transactionId,
        type: "topup_completed",
      },
    })

    if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
      await removeDeviceTokens({
        userId: recipientUser.id,
        deviceTokens: result.tokens,
      })
    } else if (result instanceof NotificationsServiceError) {
      logger.error(result, "Failed to send topup completed notification")
      // Don't block - return true to continue processing
    }

    return true
  } catch (err) {
    return handleCommonNotificationErrors(err)
  }
}
```

**Add both methods to the return object at the end of NotificationsService:**

```typescript
return {
  lightningTxReceived,
  intraLedgerTxReceived,
  onChainTxReceived,
  onChainTxReceivedPending,
  onChainTxSent,
  priceUpdate,
  sendBalance,
  adminPushNotificationSend,
  adminPushNotificationFilteredSend,
  topupInitiated,              // ← NEW
  topupCompleted,              // ← NEW
}
```

---

## Step 4: Add Middleware to Webhook Handler

### File: `src/services/ibex/webhook-server/routes/on-receive.ts`

**Add new middleware after existing middleware functions:**

```typescript
/**
 * Middleware to send topup initiated notification
 * Runs immediately after payment validation, before processing
 * Does not block payment processing if notification fails
 */
const sendTopupInitiatedNotification = async (
  req: PaymentRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  const { transaction, receivedMsat, paymentProvider } = req.body
  const receivedSat = receivedMsat / 1000
  const { receiverWallet, recipientAccount, recipientUser } = req.paymentContext

  try {
    const nsResp = await NotificationsService().topupInitiated({
      recipientAccountId: recipientAccount.id,
      recipientWalletId: receiverWallet.id,
      paymentAmount: toPaymentAmount(receiverWallet.currency)(transaction.amount),
      displayPaymentAmount: await toDisplayAmount(recipientAccount.displayCurrency)(
        receivedSat,
      ),
      recipientDeviceTokens: recipientUser.deviceTokens,
      recipientNotificationSettings: recipientAccount.notificationSettings,
      recipientLanguage: recipientUser.language,
      paymentProvider: paymentProvider || "unknown",
      transactionId: transaction.id,
    })

    if (nsResp instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
      await removeDeviceTokens({
        userId: recipientUser.id,
        deviceTokens: nsResp.tokens,
      })
    } else if (nsResp instanceof NotificationsServiceError) {
      logger.error(nsResp, "Failed to send topup initiated notification")
      // Don't block payment processing
    }
  } catch (err) {
    logger.error(
      { err },
      "Error in sendTopupInitiatedNotification middleware",
    )
    // Don't block payment processing
  }

  next()
}
```

---

## Step 5: Add Middleware to Webhook Routes

**In the same file, update the webhook route to include the new middleware:**

```typescript
// For topup invoice endpoint
router.post(
  paths.topup,              // Or use existing path
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendTopupInitiatedNotification,  // ← NEW - before other processing
  sendLightningNotification,        // ← existing notification still runs
  sendZapReceipt,                   // ← existing zap processing
  (_req: Request, resp: Response) => resp.status(200).end(),
)
```

---

## Step 6: Add i18n Translations

### File: `src/locales/en.json` (or your i18n file)

**Add translation keys:**

```json
{
  "notification": {
    "transaction": {
      "topup_initiated": {
        "title": "Payment Received",
        "body": "Received {{baseCurrencyAmount}}{{baseCurrencyName}} - Processing your payment",
        "bodyDisplayCurrency": "Received {{displayCurrencyAmount}} ({{baseCurrencyAmount}}{{baseCurrencyName}}) - Processing your payment"
      },
      "topup_completed": {
        "title": "Payment Confirmed",
        "body": "Successfully credited {{baseCurrencyAmount}}{{baseCurrencyName}} to your wallet",
        "bodyDisplayCurrency": "Successfully credited {{displayCurrencyAmount}} ({{baseCurrencyAmount}}{{baseCurrencyName}}) to your wallet"
      }
    }
  }
}
```

### For Spanish (`es.json`):

```json
{
  "notification": {
    "transaction": {
      "topup_initiated": {
        "title": "Pago Recibido",
        "body": "Recibido {{baseCurrencyAmount}}{{baseCurrencyName}} - Procesando tu pago",
        "bodyDisplayCurrency": "Recibido {{displayCurrencyAmount}} ({{baseCurrencyAmount}}{{baseCurrencyName}}) - Procesando tu pago"
      },
      "topup_completed": {
        "title": "Pago Confirmado",
        "body": "{{baseCurrencyAmount}}{{baseCurrencyName}} acreditados exitosamente en tu billetera",
        "bodyDisplayCurrency": "{{displayCurrencyAmount}} ({{baseCurrencyAmount}}{{baseCurrencyName}}) acreditados exitosamente en tu billetera"
      }
    }
  }
}
```

---

## Step 7: Unit Tests

### File: `test/unit/services/notifications/topup-notifications.spec.ts`

```typescript
import { NotificationsService } from "@services/notifications"
import { NotificationType } from "@domain/notifications"
import { NotificationsServiceError } from "@domain/notifications"

describe("TopupNotifications", () => {
  describe("topupInitiated", () => {
    it("should send notification with correct title and body", async () => {
      const result = await NotificationsService().topupInitiated({
        recipientAccountId: "account-123" as AccountId,
        recipientWalletId: "wallet-123" as WalletId,
        paymentAmount: {
          amount: 1000n,
          currency: WalletCurrency.Usd,
        },
        displayPaymentAmount: {
          amountInMinor: 5000n,
          currency: "USD" as DisplayCurrency,
        },
        recipientDeviceTokens: ["token-123"],
        recipientNotificationSettings: {
          push: { enabled: true, disabledCategories: [] },
        },
        recipientLanguage: "en",
        paymentProvider: "fygaro",
        transactionId: "tx-123",
      })

      expect(result).toBe(true)
    })

    it("should handle no device tokens gracefully", async () => {
      const result = await NotificationsService().topupInitiated({
        recipientAccountId: "account-123" as AccountId,
        recipientWalletId: "wallet-123" as WalletId,
        paymentAmount: {
          amount: 1000n,
          currency: WalletCurrency.Usd,
        },
        recipientDeviceTokens: [],  // ← No tokens
        recipientNotificationSettings: {
          push: { enabled: true, disabledCategories: [] },
        },
        recipientLanguage: "en",
        paymentProvider: "fygaro",
        transactionId: "tx-123",
      })

      expect(result).toBe(true)
    })

    it("should not block on notification service error", async () => {
      // Mock NotificationsService to throw error
      // Verify that the method returns true despite error
      // This ensures payment processing continues
    })
  })

  describe("topupCompleted", () => {
    it("should send completion notification", async () => {
      const result = await NotificationsService().topupCompleted({
        recipientAccountId: "account-123" as AccountId,
        recipientWalletId: "wallet-123" as WalletId,
        paymentAmount: {
          amount: 1000n,
          currency: WalletCurrency.Usd,
        },
        recipientDeviceTokens: ["token-123"],
        recipientNotificationSettings: {
          push: { enabled: true, disabledCategories: [] },
        },
        recipientLanguage: "en",
        transactionId: "tx-123",
      })

      expect(result).toBe(true)
    })
  })
})
```

---

## Step 8: Integration Tests

### File: `test/integration/ibex-webhook-topup.spec.ts`

```typescript
import request from "supertest"
import { app } from "@servers"

describe("Topup Webhook Integration", () => {
  it("should send initial notification within 1-2 seconds of webhook receipt", async () => {
    const startTime = Date.now()

    const response = await request(app)
      .post("/ibex-webhook/receive/topup")
      .set("Authorization", "Bearer valid-token")
      .send({
        transaction: {
          id: "tx-123",
          accountId: "wallet-123",
          amount: 1000,
          hash: "hash-123",
          invoice: { hash: "invoice-hash" },
        },
        receivedMsat: 1000000,
        paymentProvider: "fygaro",
      })

    const endTime = Date.now()
    const elapsed = endTime - startTime

    expect(response.status).toBe(200)
    expect(elapsed).toBeLessThan(2000) // within 1-2 seconds
  })

  it("should include payment amount in notification", async () => {
    // Mock Firebase messaging
    // Verify notification contains amount and currency
  })

  it("should handle both USD and BTC wallets", async () => {
    // Test with USD wallet
    // Test with BTC wallet
    // Verify both receive notifications with correct currency
  })

  it("should not block payment processing if notification fails", async () => {
    // Mock Firebase messaging to fail
    // Verify that webhook still returns 200 OK
    // Verify payment processing continues
  })
})
```

---

## Key Implementation Notes

### Non-Blocking Pattern

**Always ensure notification failures don't block payment processing:**

```typescript
try {
  const result = await NotificationsService().topupInitiated({...})
  
  if (result instanceof NotificationsServiceError) {
    logger.error(result, "Notification failed")
    // DON'T throw - just log and continue
  }
} catch (err) {
  logger.error(err, "Notification middleware error")
  // DON'T throw - just log and continue
}

next() // Always call next() to continue processing
```

### Error Handling Pattern

```typescript
if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
  // Handle invalid tokens
  await removeDeviceTokens({
    userId: recipientUser.id,
    deviceTokens: result.tokens,
  })
} else if (result instanceof NotificationsServiceError) {
  // Log other errors but don't block
  logger.error(result)
}
```

### Type Safety

Ensure all types are properly imported:

```typescript
import { TopupInitiatedArgs, TopupCompletedArgs } from "@domain/notifications"
import { NotificationsServiceError } from "@domain/notifications"
import { PaymentAmount, WalletCurrency } from "@domain/shared"
```

---

## Common Pitfalls to Avoid

❌ **DON'T:** Throw errors in notification middleware
✅ **DO:** Log and continue processing

❌ **DON'T:** Await full Firebase response
✅ **DO:** Use fire-and-forget pattern with error handling

❌ **DON'T:** Forget to check notification settings
✅ **DO:** Always pass `recipientNotificationSettings`

❌ **DON'T:** Accumulate invalid device tokens
✅ **DO:** Remove invalid tokens immediately

❌ **DON'T:** Skip error logging
✅ **DO:** Log all errors for debugging

---

## Verification Checklist

Before submitting PR, verify:

- [ ] All TypeScript types compile without errors
- [ ] Unit tests pass (>80% coverage)
- [ ] Integration tests pass
- [ ] i18n keys are correctly formatted
- [ ] No blocking in middleware
- [ ] Invalid tokens removed on error
- [ ] Notification settings respected
- [ ] Error logging sufficient
- [ ] Timing meets 1-2 second requirement
- [ ] Works with USD and BTC wallets
