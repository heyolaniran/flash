# Quick Reference: Top-Up Notifications Implementation

## One-Page Implementation Checklist

### Phase 1: Domain Types (1-2 hours)
```bash
File: src/domain/notifications/index.ts
─────────────────────────────────────────
[ ] Add TopupInitiated: "topup_initiated"
[ ] Add TopupCompleted: "topup_completed"
```

```bash
File: src/domain/notifications/index.types.d.ts
─────────────────────────────────────────────────
[ ] Add type TopupInitiatedArgs
[ ] Add type TopupCompletedArgs
[ ] Update INotificationsService interface
[ ] Test TypeScript compilation
```

### Phase 2: Notification Service (2-3 hours)
```bash
File: src/services/notifications/index.ts
───────────────────────────────────────────
[ ] Implement topupInitiated() method
[ ] Implement topupCompleted() method
[ ] Add to return object
[ ] Test error handling
```

### Phase 3: i18n Translations (1 hour)
```bash
Files: src/locales/*.json
──────────────────────────
[ ] Add en.json translations
[ ] Add es.json translations (if applicable)
[ ] Add other language translations
[ ] Verify key structure matches
```

### Phase 4: Webhook Integration (2-3 hours)
```bash
File: src/services/ibex/webhook-server/routes/on-receive.ts
───────────────────────────────────────────────────────────
[ ] Add sendTopupInitiatedNotification middleware
[ ] Add to webhook route (before payment processing)
[ ] Add error handling
[ ] Verify non-blocking
```

### Phase 5: Testing (3-4 hours)
```bash
Files: test/**/*.spec.ts
─────────────────────────
[ ] Unit tests for topupInitiated()
[ ] Unit tests for topupCompleted()
[ ] Integration tests for webhook flow
[ ] Manual testing on devices
[ ] Coverage >80%
```

---

## Key Code Snippets

### 1. Add Notification Types
```typescript
// src/domain/notifications/index.ts
export const NotificationType = {
  // ... existing ...
  TopupInitiated: "topup_initiated",
  TopupCompleted: "topup_completed",
} as const
```

### 2. Add Types
```typescript
// src/domain/notifications/index.types.d.ts
type TopupInitiatedArgs = TransactionReceivedNotificationBaseArgs & {
  paymentProvider: "fygaro" | "stripe" | "paypal" | string
  transactionId: string
}

type TopupCompletedArgs = TransactionReceivedNotificationBaseArgs & {
  transactionId: string
}
```

### 3. Add Interface Methods
```typescript
// src/domain/notifications/index.types.d.ts
interface INotificationsService {
  topupInitiated(args: TopupInitiatedArgs): Promise<true | NotificationsServiceError>
  topupCompleted(args: TopupCompletedArgs): Promise<true | NotificationsServiceError>
}
```

### 4. Implement Methods (Template)
```typescript
// src/services/notifications/index.ts
const topupInitiated = async (args: TopupInitiatedArgs) => {
  try {
    if (!args.recipientDeviceTokens?.length) return true
    
    const { title, body } = createPushNotificationContent({
      type: NotificationType.TopupInitiated,
      userLanguage: args.recipientLanguage,
      amount: args.paymentAmount,
      displayAmount: args.displayPaymentAmount,
    })
    
    const result = await pushNotification.sendFilteredNotification({
      deviceTokens: args.recipientDeviceTokens,
      title,
      body,
      notificationCategory: GaloyNotificationCategories.Payments,
      notificationSettings: args.recipientNotificationSettings,
      data: {
        transactionId: args.transactionId,
        paymentProvider: args.paymentProvider,
        type: "topup_initiated",
      },
    })
    
    if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
      await removeDeviceTokens({
        userId: recipientUser.id,
        deviceTokens: result.tokens,
      })
    } else if (result instanceof NotificationsServiceError) {
      logger.error(result)
    }
    
    return true
  } catch (err) {
    return handleCommonNotificationErrors(err)
  }
}
```

### 5. Add Middleware
```typescript
// src/services/ibex/webhook-server/routes/on-receive.ts
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
    const result = await NotificationsService().topupInitiated({
      recipientAccountId: recipientAccount.id,
      recipientWalletId: receiverWallet.id,
      paymentAmount: toPaymentAmount(receiverWallet.currency)(transaction.amount),
      displayPaymentAmount: await toDisplayAmount(recipientAccount.displayCurrency)(receivedSat),
      recipientDeviceTokens: recipientUser.deviceTokens,
      recipientNotificationSettings: recipientAccount.notificationSettings,
      recipientLanguage: recipientUser.language,
      paymentProvider: paymentProvider || "unknown",
      transactionId: transaction.id,
    })
    
    if (result instanceof NotificationsServiceError) {
      logger.error(result)
    }
  } catch (err) {
    logger.error({ err }, "Error in sendTopupInitiatedNotification")
  }
  
  next()
}
```

### 6. Update Route
```typescript
// In same file, update router
router.post(
  paths.invoice,
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendTopupInitiatedNotification,  // ← ADD THIS LINE
  sendLightningNotification,
  sendZapReceipt,
  (_req: Request, resp: Response) => resp.status(200).end(),
)
```

### 7. Add Translations
```json
// src/locales/en.json
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

---

## Critical Don'ts

❌ **DON'T throw errors in middleware** → LOG and continue  
❌ **DON'T await Firebase response** → Fire-and-forget pattern  
❌ **DON'T skip notification settings** → Always check user prefs  
❌ **DON'T forget to remove invalid tokens** → Clean up immediately  
❌ **DON'T expose device tokens in logs** → Only log count  
❌ **DON'T block payment processing** → Notification should be independent  
❌ **DON'T forget i18n keys** → Add to all languages  

---

## Critical Do's

✅ **DO use try-catch** in middleware  
✅ **DO return errors** instead of throwing  
✅ **DO call next()** even if notification fails  
✅ **DO remove invalid tokens** from user profile  
✅ **DO log all errors** for debugging  
✅ **DO respect notification settings** always  
✅ **DO handle multiple currencies** correctly  
✅ **DO test on real devices** before merge  

---

## File Modification Summary

| File | Lines | Changes |
|------|-------|---------|
| src/domain/notifications/index.ts | 5-15 | Add 2 notification types |
| src/domain/notifications/index.types.d.ts | 30-50 | Add 2 types + 2 interface methods |
| src/services/notifications/index.ts | 200-300 | Add 2 methods (~100 lines) |
| src/services/ibex/webhook-server/routes/on-receive.ts | 50-100 | Add 1 middleware (~50 lines) + 1 route update |
| Locale files | Variable | Add 2 key groups per language |
| Tests | Variable | Add 20+ test cases |

**Total Lines Added:** ~250-300 lines of code  
**Total Lines Modified:** ~10-15 lines for integration  
**New Files:** 0-1 (optional test file)

---

## Testing Commands

```bash
# Run all tests
npm test

# Run notification tests only
npm test -- tests/notifications

# Run webhook integration tests
npm test -- tests/webhook

# Lint check
npm run lint

# Type check
npm run type-check

# Build check
npm run build
```

---

## Deployment Checklist

- [ ] All TypeScript errors resolved
- [ ] All tests passing
- [ ] Code review approved
- [ ] i18n keys verified
- [ ] Device token cleanup working
- [ ] Notification settings respected
- [ ] Non-blocking verified
- [ ] Timing <2 seconds verified
- [ ] Multiple currencies tested
- [ ] Manual testing complete
- [ ] Monitoring configured
- [ ] Rollback plan documented

---

## Common Issues & Solutions

### Issue 1: Notification not sent
**Check:**
- [ ] Device tokens present and valid
- [ ] Notification settings enabled
- [ ] Firebase configured correctly
- [ ] i18n keys present
- [ ] Middleware added to route

### Issue 2: Payment processing blocked
**Check:**
- [ ] Middleware returns immediately
- [ ] next() called in middleware
- [ ] No throw statements in notification code
- [ ] Try-catch wrapping all logic

### Issue 3: Invalid tokens accumulating
**Check:**
- [ ] removeDeviceTokens called on error
- [ ] DeviceTokensNotRegistered error caught
- [ ] Token cleanup function exists

### Issue 4: Wrong notification content
**Check:**
- [ ] i18n keys match NotificationType
- [ ] Variables correctly substituted
- [ ] Language correctly passed
- [ ] createPushNotificationContent called

### Issue 5: TypeScript errors
**Check:**
- [ ] All types defined in index.types.d.ts
- [ ] Interface updated
- [ ] Method signatures match types
- [ ] All imports present

---

## Success Indicators

✅ **All tests passing** (>80% coverage)  
✅ **No TypeScript errors** (`npm run type-check`)  
✅ **No lint errors** (`npm run lint`)  
✅ **Notification received in 1-2 seconds**  
✅ **Payment still processes on notification error**  
✅ **Invalid tokens removed**  
✅ **Notification settings respected**  
✅ **Works with USD and BTC**  
✅ **Content correct for multiple languages**  
✅ **No duplicate notifications**  

---

## Time Breakdown

| Task | Time | Notes |
|------|------|-------|
| Phase 1: Domain types | 1-2h | Straightforward type additions |
| Phase 2: Service methods | 2-3h | Follow existing patterns |
| Phase 3: i18n | 1h | Copy-paste translations |
| Phase 4: Webhook integration | 2-3h | Most critical part |
| Phase 5: Testing | 3-4h | Unit + integration + manual |
| **Total** | **9-13h** | Effort estimate |

---

## Next Actions

1. Review this quick reference
2. Create branch: `git checkout -b feat/topup-notification`
3. Start with Phase 1 (domain types)
4. Commit: `git add src/domain && git commit -m "feat: add topup notification types"`
5. Continue to Phase 2
6. Test continuously
7. Request review when complete

---

## Need Help?

- **Detailed code:** See IMPLEMENTATION_GUIDE_TOPUP_NOTIFICATIONS.md
- **Architecture:** See TECHNICAL_DEEP_DIVE_TOPUP_NOTIFICATIONS.md
- **Full plan:** See PR_PLAN_TOPUP_NOTIFICATIONS.md
- **Patterns:** Check `src/services/notifications/index.ts` for similar methods
- **Webhook:** Check `src/services/ibex/webhook-server/routes/on-receive.ts` for middleware patterns
