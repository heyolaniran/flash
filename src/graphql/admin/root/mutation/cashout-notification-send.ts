import { Admin } from "@app/index";
import AdminPushNotificationSendPayload from "@graphql/admin/types/payload/admin-push-notification-send";
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map";
import { GT } from "@graphql/index";
import { SUCCESS_RESPONSE } from "@graphql/shared/types/payload/success-payload";
import { FlashNotificationCategories } from "@domain/notifications";
import { getI18nInstance } from "@config";
import { getCurrencyMajorExponent } from "@domain/fiat";

const i18n = getI18nInstance();

const CashoutNotificationSendInput = GT.Input({
    name: "CashoutNotificationSendInput",
    fields: () => ({
        accountId: {
            type: GT.NonNull(GT.String),
        },
        amount: {
            type: GT.NonNull(GT.Float),
        },
        currency: {
            type: GT.NonNull(GT.String)
        }
    })
})

const sendCashoutSettledNotification = GT.Field({
    extensions: {
        complexity: 1,
    },
    type: GT.NonNull(AdminPushNotificationSendPayload),
    args: {
        input: { type: GT.NonNull(CashoutNotificationSendInput) }
    },
    resolve: async (_, args) => {

        const { accountId, amount, currency } = args.input;

        const exponent = getCurrencyMajorExponent(currency as DisplayCurrency);
        const baseCurrencyAmount = new Intl.NumberFormat("en", {
            style: "currency",
            currency,
            currencyDisplay: "narrowSymbol",
            minimumFractionDigits: exponent,
            maximumFractionDigits: exponent,
        }).format(amount);

        const title = i18n.__({ phrase: "notification.cashout.title", locale: "en" }, { currency });
        const body = i18n.__({ phrase: "notification.cashout.body", locale: "en" }, { baseCurrencyAmount, baseCurrencyName: "", currency });
        const success = await Admin.sendAdminPushNotification({
            accountId,
            title,
            body,
            data: { amount: String(amount), currency },
            notificationCategory: FlashNotificationCategories.Cashout
        })

        if (success instanceof Error) {
            return { errors: [mapAndParseErrorForGqlResponse(success)] }
        }

        return SUCCESS_RESPONSE

    }
})

export default sendCashoutSettledNotification