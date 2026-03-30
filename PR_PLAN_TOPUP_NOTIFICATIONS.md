# PR Plan: Send Push Notifications for Top-Up Payment Initiation

## Overview
Implement immediate push notifications when top-up payments are successfully initiated through external payment providers (Fygaro, Stripe, PayPal, etc.), providing users with real-time feedback.

**Branch:** `feat/topup-notification`
**Issue:** Send push notification on top-up payment initiation

---

## Current State Analysis

### Existing Implementation
- ✅ Top-up webhooks are received and processed via Ibex webhook server
- ✅ User wallets are credited via Ibex
- ✅ Notifications sent ONLY after successful credit (post-transaction)
- ❌ No notification when payment is initially received/initiated

### Key Files Involved
```
src/
├── services/
│   ├── ibex/webhook-server/routes/
│   │   ├── on-receive.ts      (existing receive webhook handler)
│   │   ├── on-pay.ts          (lightning/onchain payment routes)
│   │   ├── middleware/        (authentication, logging)
│   │   └── index.ts           (webhook server setup)
│   └── notifications/
│       ├── index.ts           (NotificationsService main logic)
│       ├── push-notifications.ts  (Firebase messaging)
│       ├── create-push-notification-content.ts (i18n content)
│       └── firebase.ts
├── domain/
│   └── notifications/
│       ├── index.ts           (NotificationType enum)
│       ├── index.types.d.ts   (TypeScript types)
│       └── errors.ts
└── config/
    └── (i18n translations)
```

---

## Implementation Plan

### Phase 1: Add New Notification Type (Low Risk)

**Task 1.1:** Add `TopupInitiated` notification type
- **File:** `src/domain/notifications/index.ts`
- **Changes:**
  - Add `TopupInitiated: "topup_initiated"` to `NotificationType` enum
  - Add `TopupCompleted: "topup_completed"` for confirmation notification

**Why:** Separates payment initiation from completion, allows for specific i18n strings.

---

### Phase 2: Define TypeScript Types (Low Risk)

**Task 2.1:** Add new notification argument types
- **File:** `src/domain/notifications/index.types.d.ts`
- **Changes:**
  ```typescript
  type TopupInitiatedArgs = TransactionReceivedNotificationBaseArgs & {
    paymentProvider: "fygaro" | "stripe" | "paypal" | string
    transactionId: string
  }
  
  type TopupCompletedArgs = TransactionReceivedNotificationBaseArgs & {
    transactionId: string
  }
  ```
- **Why:** Type safety for new notification methods

**Task 2.2:** Update `INotificationsService` interface
- **File:** `src/domain/notifications/index.types.d.ts`
- **Changes:**
  ```typescript
  interface INotificationsService {
    // ... existing methods
    topupInitiated(args: TopupInitiatedArgs): Promise<true | NotificationsServiceError>
    topupCompleted(args: TopupCompletedArgs): Promise<true | NotificationsServiceError>
  }
  ```

---

### Phase 3: Implement Notification Methods (Medium Risk)

**Task 3.1:** Implement `topupInitiated` method in NotificationsService
- **File:** `src/services/notifications/index.ts`
- **Logic:**
  ```
  1. Validate input parameters
  2. Create push notification content with type "topup_initiated"
  3. Send filtered notification with device tokens
  4. Handle errors gracefully (don't block payment processing)
  5. Return true on success or NotificationsServiceError
  ```
- **Pattern:** Follow existing `lightningTxReceived` and `intraLedgerTxReceived` methods

**Task 3.2:** Implement `topupCompleted` method in NotificationsService
- **File:** `src/services/notifications/index.ts`
- **Logic:** Similar to `topupInitiated` but with completion context

---

### Phase 4: Add i18n Content (Low Risk)

**Task 4.1:** Add notification content strings
- **Files:** Localization files (en.json, es.json, etc. if applicable)
- **Content:**
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

**Task 4.2:** Verify i18n structure
- Confirm existing i18n system supports new notification types
- Test with multiple languages

---

### Phase 5: Hook Into Webhook Handler (Medium Risk - Critical)

**Task 5.1:** Create new top-up webhook handler structure
- **Create:** `src/services/ibex/webhook-server/routes/on-topup.ts`
- **OR Modify:** `src/services/ibex/webhook-server/routes/on-receive.ts`
- **Logic:**
  - Extract payment provider and transaction ID from webhook
  - Send initial topup notification immediately
  - Continue with existing payment processing
  - Send completion notification after successful credit

**Task 5.2:** Add middleware for topup notification
- **Pattern:** Similar to `fetchPaymentContext` and `sendLightningNotification`
- **Middleware:** `sendTopupInitiatedNotification`
  ```typescript
  const sendTopupInitiatedNotification = async (
    req: PaymentRequest,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.paymentContext) return next()
    
    const { transaction, paymentProvider } = req.body
    const { recipientAccount, recipientUser } = req.paymentContext
    
    const result = await NotificationsService().topupInitiated({
      recipientAccountId: recipientAccount.id,
      recipientWalletId: receiverWallet.id,
      paymentAmount: toPaymentAmount(transaction.amount),
      displayPaymentAmount: await toDisplayAmount(...),
      recipientDeviceTokens: recipientUser.deviceTokens,
      recipientNotificationSettings: recipientAccount.notificationSettings,
      recipientLanguage: recipientUser.language,
      paymentProvider: paymentProvider || "unknown",
      transactionId: transaction.id,
    })
    
    if (result instanceof NotificationsServiceError) {
      logger.error(result, "Failed to send topup initiated notification")
      // Don't block payment processing
    }
    
    next()
  }
  ```

**Task 5.3:** Update webhook route
- Add `sendTopupInitiatedNotification` middleware
- Run BEFORE existing payment processing middleware
- Maintain error handling to not block payment

---

### Phase 6: Testing & Validation (High Priority)

**Task 6.1:** Unit Tests
- **File:** `test/unit/services/notifications/topup.spec.ts` (or similar)
- **Tests:**
  - ✅ `topupInitiated` sends notification with correct payload
  - ✅ `topupInitiated` handles notification settings
  - ✅ `topupInitiated` gracefully handles device token errors
  - ✅ `topupInitiated` doesn't block on notification failure
  - ✅ `topupCompleted` sends completion notification

**Task 6.2:** Integration Tests
- **File:** `test/integration/ibex-webhook.spec.ts` (or similar)
- **Tests:**
  - ✅ Webhook receipt triggers initial notification within 1-2 seconds
  - ✅ Notification includes payment amount and currency
  - ✅ Notification includes display currency when applicable
  - ✅ Both USD and BTC wallets receive notifications
  - ✅ Notification failure doesn't prevent payment processing
  - ✅ Completion notification sent after credit success

**Task 6.3:** Manual Testing
- Use webhook testing tool (Bruno, Postman, or local testing script)
- Test with Fygaro webhook simulation
- Verify notification appears on test device within 1-2 seconds
- Verify both initiation and completion notifications

---

## Detailed Implementation Checklist

### Step-by-Step Implementation Order

1. **[Step 1]** Update domain types
   - [ ] Add notification type constants
   - [ ] Add argument types
   - [ ] Update interface
   - [ ] Verify TypeScript compilation

2. **[Step 2]** Implement notification service methods
   - [ ] Add `topupInitiated` method
   - [ ] Add `topupCompleted` method
   - [ ] Test error handling
   - [ ] Verify async/await patterns

3. **[Step 3]** Add i18n content
   - [ ] Add English translations
   - [ ] Add other language translations (if applicable)
   - [ ] Verify i18n keys match implementation

4. **[Step 4]** Create/update webhook handler
   - [ ] Create new middleware or extend existing
   - [ ] Add error handling
   - [ ] Test webhook payload parsing

5. **[Step 5]** Integrate into webhook routes
   - [ ] Add middleware to route pipeline
   - [ ] Test middleware order
   - [ ] Verify non-blocking behavior

6. **[Step 6]** Unit tests
   - [ ] Write notification service tests
   - [ ] Write middleware tests
   - [ ] Achieve >80% coverage

7. **[Step 7]** Integration tests
   - [ ] Test full webhook flow
   - [ ] Test timing constraints
   - [ ] Test multi-currency scenarios

8. **[Step 8]** Manual testing
   - [ ] Verify notifications received
   - [ ] Check notification content
   - [ ] Verify timing

9. **[Step 9]** Documentation
   - [ ] Update README if needed
   - [ ] Add code comments
   - [ ] Document i18n keys

---

## Acceptance Criteria Checklist

- [ ] **Timing:** Push notification sent within 1-2 seconds of webhook receipt
- [ ] **Content:** Notification includes payment amount and currency
- [ ] **Differentiation:** Different notifications for processing vs completed states
- [ ] **Multi-Currency:** Handles both USD and BTC wallets
- [ ] **Error Handling:** Gracefully handles notification failures without blocking
- [ ] **Device Tokens:** Invalid tokens removed from user profile
- [ ] **Notification Settings:** Respects user's notification preferences
- [ ] **Languages:** Content translated to supported languages
- [ ] **Logging:** All errors logged for debugging

---

## Potential Risks & Mitigation

### Risk 1: Notification Delays
**Impact:** Violates 1-2 second requirement
**Mitigation:** 
- Run notification sending asynchronously
- Don't await full Firebase response
- Log any delays for monitoring

### Risk 2: Duplicate Notifications
**Impact:** User receives multiple identical notifications
**Mitigation:**
- Add transaction ID tracking
- Use deduplication at Firebase level
- Add timestamp validation

### Risk 3: Blocking Payment Processing
**Impact:** Notification service failure prevents payment credit
**Mitigation:**
- Wrap notification calls in try-catch
- Don't throw errors, return error types
- Log but don't block on notification failure

### Risk 4: Device Token Management
**Impact:** Accumulation of invalid tokens
**Mitigation:**
- Remove invalid tokens on error
- Implement token refresh strategy
- Monitor token validity

### Risk 5: Notification Settings Ignored
**Impact:** Users receive unwanted notifications
**Mitigation:**
- Always check `recipientNotificationSettings`
- Use `shouldSendNotification` utility
- Test notification settings validation

---

## Code Examples

### Notification Service Implementation Template

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
      notificationCategory: GaloyNotificationCategories.Payments,
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
```

---

## Files to Create/Modify

### Create:
- `src/services/ibex/webhook-server/routes/on-topup.ts` (optional, if separate route)
- Tests for new functionality

### Modify:
1. `src/domain/notifications/index.ts` - Add notification types
2. `src/domain/notifications/index.types.d.ts` - Add types
3. `src/services/notifications/index.ts` - Add methods
4. `src/services/ibex/webhook-server/routes/on-receive.ts` - Add middleware
5. `src/services/ibex/webhook-server/routes/index.ts` - Update routes
6. Localization files - Add i18n content

---

## Timeline Estimate

- Phase 1-2 (Types): 1-2 hours
- Phase 3 (Service Methods): 2-3 hours
- Phase 4 (i18n): 1 hour
- Phase 5 (Webhook Integration): 2-3 hours
- Phase 6 (Testing): 3-4 hours
- **Total: ~9-13 hours**

---

## Success Metrics

✅ Code Review:
- All tests passing
- No TypeScript errors
- Follows existing code patterns

✅ Functional:
- Notification sent within 1-2 seconds
- Correct amount and currency displayed
- Both initiation and completion notifications work

✅ Quality:
- >80% test coverage
- Error handling verified
- Device token cleanup working

✅ User Experience:
- Clear, translated notification content
- Respects notification settings
- No duplicate notifications

---

## References

- **Existing Pattern:** `src/services/notifications/index.ts` - `lightningTxReceived` method
- **Webhook Handler Pattern:** `src/services/ibex/webhook-server/routes/on-receive.ts`
- **Type System:** `src/domain/notifications/index.types.d.ts`
- **Notification Content:** `src/services/notifications/create-push-notification-content.ts`
