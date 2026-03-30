# Technical Deep-Dive: Top-Up Notification Architecture

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    External Payment Providers                     │
│                 (Fygaro, Stripe, PayPal, etc.)                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                    Webhook Send
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Ibex Webhook Server                            │
│              src/servers/ibex-webhook-server.ts                  │
│                                                                   │
│  Middleware Stack:                                               │
│  1. authenticate    (verify webhook signature)                   │
│  2. logRequest      (log incoming webhook)                       │
│  3. fetchPaymentContext (retrieve user info)                     │
│  4. sendTopupInitiatedNotification ← NEW                         │
│  5. [existing payment processing]                                │
│  6. [existing success notification]                              │
└────────────────────┬───────────────────────────────────────────┘
                     │
                     ├──────────────────────────────────┐
                     │                                  │
                     ▼                                  ▼
        ┌─────────────────────────┐     ┌──────────────────────┐
        │  Notification Service   │     │  Payment Processing  │
        │ (sends immediately)     │     │    (continues)       │
        │                         │     │                      │
        │ topupInitiated()        │     │ Process payment      │
        │ ├─ Create content      │     │ ├─ Credit wallet    │
        │ ├─ Send firebase msg   │     │ ├─ Update ledger    │
        │ ├─ Handle errors       │     │ └─ Log transaction  │
        │ └─ Return result       │     │                      │
        └──────────┬──────────────┘     └──────────┬───────────┘
                   │                              │
                   │ Firebase                      │ After success
                   │ (sends push)                  │
                   ▼                              ▼
        ┌─────────────────────────┐     ┌──────────────────────┐
        │   User Device           │     │ topupCompleted()     │
        │ (receives notification) │     │ (sends confirmation) │
        │                         │     │                      │
        │ "Payment Received"      │     │ Create content       │
        │ "$10.00 - Processing"   │     │ Send firebase msg    │
        │                         │     │ Handle errors        │
        └─────────────────────────┘     └──────────┬───────────┘
                                                   │
                                                   ▼
                                        ┌─────────────────────────┐
                                        │   User Device           │
                                        │                         │
                                        │ "Payment Confirmed"     │
                                        │ "$10.00 credited"       │
                                        └─────────────────────────┘
```

---

## Data Flow Sequence Diagram

```
Time: T+0ms
├─ Webhook received from payment provider
├─ Authenticate & log
├─ Fetch payment context (user, wallet, account)
│
Time: T+100ms
├─ CREATE: topupInitiated notification
│  ├─ Validate parameters
│  ├─ Create i18n content
│  ├─ Send via Firebase (non-blocking)
│  └─ Return immediately (don't wait for Firebase)
│
Time: T+150ms
├─ PROCESS: Payment in ledger
│  ├─ Credit wallet
│  ├─ Update transaction status
│  └─ Commit to database
│
Time: T+500-1000ms
├─ FIREBASE: Push notification delivered
│  └─ User sees: "Payment Received: $10.00 - Processing"
│
Time: T+1500ms
├─ SEND: topupCompleted notification
│  ├─ Verify credit success
│  ├─ Create confirmation content
│  ├─ Send via Firebase
│  └─ Return
│
Time: T+2000ms
└─ FIREBASE: Confirmation notification delivered
   └─ User sees: "Payment Confirmed: $10.00 credited"
```

---

## Component Breakdown

### 1. Notification Types

**Domain Location:** `src/domain/notifications/index.ts`

**Purpose:** Define notification types for TypeScript and i18n lookup

```typescript
NotificationType = {
  TopupInitiated: "topup_initiated",   // Payment webhook received
  TopupCompleted: "topup_completed",   // Payment credited successfully
}
```

**Why These Types Matter:**
- Type safety in TypeScript
- i18n key lookup: `notification.transaction.topup_initiated`
- Enables analytics/filtering
- Allows client-side handling

---

### 2. Argument Types

**Domain Location:** `src/domain/notifications/index.types.d.ts`

**Purpose:** Define strongly-typed arguments for notification methods

```typescript
type TopupInitiatedArgs = TransactionReceivedNotificationBaseArgs & {
  paymentProvider: "fygaro" | "stripe" | "paypal" | string
  transactionId: string
}
```

**Components:**
- `TransactionReceivedNotificationBaseArgs` - reusable base
  - `recipientAccountId` - Account receiving payment
  - `recipientWalletId` - Wallet to credit
  - `paymentAmount` - Amount in wallet currency
  - `displayPaymentAmount` - Amount in display currency (optional)
  - `recipientDeviceTokens` - Firebase tokens for push
  - `recipientNotificationSettings` - User preferences
  - `recipientLanguage` - User's language for i18n

- Additional fields:
  - `paymentProvider` - Track which provider initiated payment
  - `transactionId` - Track specific transaction

---

### 3. Notification Service Methods

**Location:** `src/services/notifications/index.ts`

**Method: `topupInitiated`**

```typescript
topupInitiated = async (args: TopupInitiatedArgs) => {
  // 1. Validate device tokens exist
  // 2. Create localized notification content
  // 3. Send via Firebase (fire-and-forget)
  // 4. Handle device token errors
  // 5. Return true or error
  // 6. Never throw - always return result
}
```

**Key Characteristics:**
- Non-blocking (returns quickly)
- Error recovery (removes invalid tokens)
- Respects user settings (checks notificationSettings)
- Multi-language support (uses i18n)
- No payment processing blocking

---

### 4. Firebase Messaging Integration

**Location:** `src/services/notifications/push-notifications.ts`

**How It Works:**
```typescript
// Step 1: Create notification content
const { title, body } = createPushNotificationContent({
  type: NotificationType.TopupInitiated,
  amount: paymentAmount,
  displayAmount: displayPaymentAmount,
  userLanguage: recipientLanguage,
})

// Step 2: Send via Firebase (fire-and-forget pattern)
const result = await pushNotification.sendFilteredNotification({
  deviceTokens,
  title,
  body,
  notificationSettings, // Respects user preferences
  data: {
    transactionId,
    paymentProvider,
  },
})

// Step 3: Handle errors without blocking
if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
  await removeDeviceTokens({ userId, deviceTokens: result.tokens })
}
```

**Firebase Message Structure:**
```javascript
{
  notification: {
    title: "Payment Received",
    body: "Received $10.00 - Processing your payment",
  },
  data: {
    transactionId: "tx-123",
    paymentProvider: "fygaro",
    type: "topup_initiated",
  },
  token: "device-token-xyz",
}
```

---

### 5. Webhook Handler Middleware

**Location:** `src/services/ibex/webhook-server/routes/on-receive.ts`

**Middleware Stack Order (Critical):**

```typescript
router.post(
  "/receive/topup",
  authenticate,                          // 1. Verify webhook
  logRequest,                            // 2. Log for debugging
  fetchPaymentContext,                   // 3. Get user info
  sendTopupInitiatedNotification,        // 4. Send initial notification ← NEW
  existingPaymentProcessing,             // 5. Process payment
  sendTopupCompletedNotification,        // 6. Send completion notification
  (_req, res) => res.status(200).end(), // 7. Return success
)
```

**Why This Order Matters:**
- ✅ Notification sent BEFORE payment processing (meets UX requirement)
- ✅ User notified even if payment processing slow
- ✅ If notification fails, payment still processes
- ✅ Completion notification sent AFTER credit confirmed

---

### 6. i18n Content Structure

**Location:** Localization files (e.g., `src/locales/en.json`)

**Translation Keys:**
```json
{
  "notification.transaction.topup_initiated.title": "Payment Received",
  "notification.transaction.topup_initiated.body": "Received {{baseCurrencyAmount}}{{baseCurrencyName}} - Processing your payment",
  "notification.transaction.topup_initiated.bodyDisplayCurrency": "Received {{displayCurrencyAmount}} ({{baseCurrencyAmount}}{{baseCurrencyName}}) - Processing your payment",
  "notification.transaction.topup_completed.title": "Payment Confirmed",
  "notification.transaction.topup_completed.body": "Successfully credited {{baseCurrencyAmount}}{{baseCurrencyName}} to your wallet",
  "notification.transaction.topup_completed.bodyDisplayCurrency": "Successfully credited {{displayCurrencyAmount}} ({{baseCurrencyAmount}}{{baseCurrencyName}}) to your wallet"
}
```

**Variable Substitution:**
- `{{baseCurrencyAmount}}` - Amount in sats or dollars
- `{{baseCurrencyName}}` - "sats" for BTC, empty for USD
- `{{displayCurrencyAmount}}` - Converted amount (if different from base)

**Example Substitution:**
```
Template: "Received {{baseCurrencyAmount}}{{baseCurrencyName}} - Processing"
Base: 10,000 sats
Display: $30 USD

Result: "Received 10,000 sats - Processing"
         AND
         "Received $30 USD (10,000 sats) - Processing"
```

---

## Error Handling Strategy

### Error Type 1: Device Token Invalid

**Scenario:** Firebase returns "registration-token-not-registered"

**Handling:**
```typescript
if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
  await removeDeviceTokens({
    userId: recipientUser.id,
    deviceTokens: result.tokens, // Remove invalid tokens
  })
  return true // Don't fail, just clean up
}
```

**Impact:** Token removed, future notifications won't attempt this token

---

### Error Type 2: Firebase Unavailable

**Scenario:** Firebase API is down or unreachable

**Handling:**
```typescript
if (result instanceof NotificationsServiceError) {
  logger.error(result, "Failed to send notification")
  // Log error for monitoring
  return true // Continue payment processing
}
```

**Impact:** Payment processes even if Firebase unavailable (user can see in wallet)

---

### Error Type 3: Notification Settings Disabled

**Scenario:** User has disabled payment notifications

**Handling:**
```typescript
// Built into shouldSendNotification utility
const shouldSend = shouldSendNotification({
  notificationSettings,
  notificationCategory: GaloyNotificationCategories.Payments,
})
```

**Impact:** Respects user privacy preferences

---

### Error Type 4: Missing Device Tokens

**Scenario:** User has no devices registered

**Handling:**
```typescript
if (!recipientDeviceTokens || recipientDeviceTokens.length === 0) {
  return true // Gracefully handle, no tokens to send to
}
```

**Impact:** No error, just skip notification

---

## Performance Considerations

### Timing Requirement: 1-2 seconds

**How to Meet:**
```
T+0ms    Webhook received
T+50ms   Authorization & context loading (database)
T+100ms  Notification sent (fire-and-forget)
         ↓
         Firebase handles from here (async)
T+150ms  Payment processing starts (parallel)
T+500ms  Firebase delivers notification
T+1000ms Payment completed, sends completion notification
T+1500ms Completion notification delivered
```

**Key: Use Fire-and-Forget**
```typescript
// DON'T DO THIS:
await messaging.send(message) // Waits for Firebase response

// DO THIS:
messaging.send(message).catch(err => {
  logger.error(err)
  // Don't throw or await
})
```

---

### Asynchronous Pattern

**Benefits:**
- Notification sent immediately
- Don't wait for Firebase confirmation
- Payment processing happens in parallel
- User sees notification within 1-2 seconds

**Implementation:**
```typescript
// Send notification but don't wait
const notificationPromise = pushNotification.sendFilteredNotification({...})

// Continue payment processing immediately
const paymentResult = await processPayment(...)

// Optionally handle notification result later
try {
  const result = await notificationPromise
  if (result instanceof Error) {
    logger.error(result)
  }
} catch (err) {
  logger.error(err)
}
```

---

## Multi-Currency Handling

### Scenario 1: USD Wallet Topup

**Input:**
```typescript
{
  paymentAmount: { amount: 1000n, currency: "USD" },  // $10.00
  displayPaymentAmount: { amountInMinor: 350000n, currency: "BRL" }, // ~R$35
}
```

**i18n Rendering:**
```
Title: "Payment Received"
Body (USD primary): "Received $10.00 - Processing your payment"
Body (with display): "Received R$35 ($10.00) - Processing your payment"
```

### Scenario 2: BTC Wallet Topup

**Input:**
```typescript
{
  paymentAmount: { amount: 5000n, currency: "BTC" },  // 5000 sats
  displayPaymentAmount: { amountInMinor: 1500000n, currency: "USD" }, // ~$0.005
}
```

**i18n Rendering:**
```
Title: "Payment Received"
Body (BTC primary): "Received 5,000 sats - Processing your payment"
Body (with display): "Received $0.005 (5,000 sats) - Processing your payment"
```

---

## Testing Strategy

### Unit Tests: Service Methods

**Focus:** Notification creation and error handling

```typescript
test("topupInitiated sends correct notification", async () => {
  // Mock Firebase
  // Call topupInitiated
  // Assert notification content matches i18n
  // Assert error handling
})
```

### Integration Tests: Full Webhook

**Focus:** End-to-end notification flow

```typescript
test("webhook sends notification within 1-2 seconds", async () => {
  // Mock Firebase with delay
  // Send webhook
  // Measure time to notification
  // Assert < 2 seconds
  // Assert payment processed
})
```

### Manual Tests: Real Devices

**Focus:** Actual user experience

```
1. Register test device with Firebase
2. Send webhook from Postman/Bruno
3. Verify notification appears on device
4. Verify content is correct
5. Verify amount and currency displayed
6. Verify notification disappears after interaction
7. Verify payment shows in wallet
```

---

## Monitoring & Debugging

### Logs to Add

**In notification middleware:**
```typescript
logger.info({
  transactionId,
  paymentProvider,
  recipientAccountId,
  deviceTokenCount: recipientDeviceTokens.length,
}, "Sending topup initiated notification")

logger.error({
  err: result,
  transactionId,
  recipientAccountId,
}, "Failed to send topup notification")
```

**In service method:**
```typescript
logger.debug({
  notificationType: NotificationType.TopupInitiated,
  paymentAmount: paymentAmount.amount,
  currency: paymentAmount.currency,
}, "Creating topup notification content")
```

### Monitoring Metrics

- Count of notifications sent
- Count of notifications failed
- Invalid tokens removed (per day)
- Average time from webhook to notification
- Device token error rates

---

## Security Considerations

### 1. Webhook Authentication

```typescript
// Already handled by authenticate middleware
// Verifies: signature, timestamp, request body integrity
router.post(
  "/receive/topup",
  authenticate, // ← Checks signature
  ...
)
```

### 2. Device Token Safety

```typescript
// Never expose device tokens in logs
logger.info({
  deviceTokenCount: tokens.length, // ← Count, not actual tokens
  // NOT: deviceTokens: tokens
})

// Remove invalid tokens immediately
await removeDeviceTokens({ userId, deviceTokens: invalidTokens })
```

### 3. User Privacy

```typescript
// Always check notification settings
const result = await pushNotification.sendFilteredNotification({
  notificationSettings: recipientNotificationSettings, // ← Respect choices
})
```

### 4. Data Validation

```typescript
// Validate all inputs
if (!recipientAccountId) throw new Error("Missing account ID")
if (!paymentAmount) throw new Error("Missing payment amount")
if (!recipientLanguage) throw new Error("Missing language")
```

---

## Deployment Checklist

- [ ] All TypeScript types compile
- [ ] Unit tests pass (>80% coverage)
- [ ] Integration tests pass
- [ ] i18n keys added to all languages
- [ ] Logging configured
- [ ] Error monitoring configured
- [ ] Middleware order verified
- [ ] Non-blocking verified
- [ ] Device token cleanup verified
- [ ] Notification settings respected
- [ ] Manual testing on devices
- [ ] Performance meets 1-2 second requirement
- [ ] Multi-currency scenarios tested
- [ ] Rollback plan documented

---

## References

### Existing Patterns in Codebase

1. **Similar Pattern:** `lightningTxReceived` in `src/services/notifications/index.ts`
   - Same error handling
   - Same i18n pattern
   - Same device token management

2. **Middleware Pattern:** `sendLightningNotification` in `src/services/ibex/webhook-server/routes/on-receive.ts`
   - Same try-catch structure
   - Same error logging
   - Same non-blocking approach

3. **Type Pattern:** `LightningTxReceivedArgs` in `src/domain/notifications/index.types.d.ts`
   - Same argument structure
   - Same composition pattern
   - Same type safety approach

### External References

- Firebase Messaging: https://firebase.google.com/docs/cloud-messaging
- i18n Best Practices: Your internal i18n documentation
- Type Safety in TypeScript: Your internal TypeScript guide
