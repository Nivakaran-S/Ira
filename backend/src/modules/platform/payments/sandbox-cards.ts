/**
 * Test cards for the sandbox gateway, in the style of real providers' test modes: a few magic
 * numbers give each outcome, anything malformed is rejected on the form like a real checkout
 * would, and any other well-formed card is declined. Card numbers are never stored or logged.
 */
export type CardBrand = 'Visa' | 'Mastercard' | 'Amex' | 'Card';

export interface CardInput {
  number: string;
  expiry: string;
  cvc: string;
  name: string;
}

export type CardOutcome =
  | { kind: 'invalid'; message: string }
  | { kind: 'approved'; brand: CardBrand; last4: string }
  | { kind: 'challenge'; brand: CardBrand; last4: string }
  | { kind: 'declined'; brand: CardBrand; last4: string; code: string; reason: string };

/** What the 3-D Secure step accepts. */
export const SANDBOX_OTP = '123456';

export const TEST_CARDS: ReadonlyArray<{ number: string; what: string }> = [
  { number: '4242 4242 4242 4242', what: 'Visa, approved' },
  { number: '5555 5555 5555 4444', what: 'Mastercard, approved' },
  { number: '3782 822463 10005', what: 'Amex, approved (4-digit CVC)' },
  { number: '4000 0025 0000 3155', what: `needs a 3-D Secure code (use ${SANDBOX_OTP})` },
  { number: '4000 0000 0000 0002', what: 'declined' },
  { number: '4000 0000 0000 9995', what: 'insufficient funds' },
  { number: '4000 0000 0000 0069', what: 'expired card' },
  { number: '4000 0000 0000 0127', what: 'wrong security code' },
  { number: '4000 0000 0000 0119', what: 'processing error' },
];

const DECLINES: Record<string, { code: string; reason: string }> = {
  '4000000000000002': { code: 'card_declined', reason: 'Your card was declined.' },
  '4000000000009995': { code: 'insufficient_funds', reason: 'Your card has insufficient funds.' },
  '4000000000000069': { code: 'expired_card', reason: 'Your card has expired.' },
  '4000000000000127': { code: 'incorrect_cvc', reason: "Your card's security code is incorrect." },
  '4000000000000119': { code: 'processing_error', reason: 'An error occurred while processing your card. Try again in a little while.' },
};
const APPROVED = new Set(['4242424242424242', '5555555555554444', '378282246310005']);
const CHALLENGE = new Set(['4000002500003155']);

export const digitsOf = (s: string) => s.replace(/[\s-]/g, '');

export function brandOf(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  return 'Card';
}

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function evaluateCard(input: CardInput, now = new Date()): CardOutcome {
  const digits = digitsOf(input.number);
  if (!/^\d{13,19}$/.test(digits) || !luhn(digits)) return { kind: 'invalid', message: 'Your card number is invalid.' };
  const brand = brandOf(digits);
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(input.expiry.trim());
  const month = m ? Number(m[1]) : 0;
  if (!m || month < 1 || month > 12) return { kind: 'invalid', message: "Your card's expiry date is invalid. Use MM / YY." };
  // A card works through the end of its expiry month.
  if (new Date(2000 + Number(m[2]), month, 1).getTime() <= now.getTime()) return { kind: 'invalid', message: "Your card's expiry date is in the past." };
  if (!new RegExp(`^\\d{${brand === 'Amex' ? 4 : 3}}$`).test(input.cvc.trim())) return { kind: 'invalid', message: "Your card's security code is incomplete." };
  if (!input.name.trim()) return { kind: 'invalid', message: 'Enter the name on the card.' };

  const last4 = digits.slice(-4);
  const decline = DECLINES[digits];
  if (decline) return { kind: 'declined', brand, last4, ...decline };
  if (CHALLENGE.has(digits)) return { kind: 'challenge', brand, last4 };
  if (APPROVED.has(digits)) return { kind: 'approved', brand, last4 };
  return { kind: 'declined', brand, last4, code: 'do_not_honor', reason: 'Your card was declined. Use one of the test cards listed on this page.' };
}
