import Stripe from "stripe";
import { STRIPE_X402_API_VERSION } from "./config.js";

// Stripe's published types track LatestApiVersion. x402 transaction_verification
// requires the preview version from https://docs.stripe.com/payments/machine/x402.md
const PREVIEW = STRIPE_X402_API_VERSION as Stripe.LatestApiVersion;

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: PREVIEW });
}

type SettleLike = { transaction?: string; success?: boolean };
type RequirementsLike = { amount: string };

export async function recordSettledPayment(
  stripe: Stripe,
  result: SettleLike,
  requirements: RequirementsLike,
): Promise<string | undefined> {
  const txHash = result.transaction;
  if (!txHash || !result.success) return;

  // requirements.amount is in atomic USDC units (6 decimals).
  // $0.01 = 10000 atomic units. Convert to cents for Stripe.
  const amountInCents = Math.round(Number(requirements.amount) / 10000);
  if (amountInCents < 1) return;

  const params = {
    amount: amountInCents,
    currency: "usd",
    confirm: true,
    payment_method_data: { type: "crypto" },
    payment_method_types: ["crypto"],
    payment_method_options: {
      crypto: {
        mode: "transaction_verification",
        transaction_verification_options: {
          network: "base",
          transaction_hash: txHash,
        },
      },
    },
  };

  const pi = await stripe.paymentIntents.create(
    params as Stripe.PaymentIntentCreateParams,
    { idempotencyKey: txHash },
  );

  console.log(`Recorded PaymentIntent ${pi.id} for tx ${txHash}`);
  return pi.id;
}
