import { describe, expect, it } from 'vitest';
import { evaluateCard, luhn, TEST_CARDS, digitsOf } from './sandbox-cards.js';

const now = new Date('2026-11-17T10:00:00Z');
const card = (number: string, over: Partial<{ expiry: string; cvc: string; name: string }> = {}) => ({ number, expiry: '12 / 30', cvc: '123', name: 'Niva S', ...over });

describe('sandbox test cards', () => {
  it('every listed test card passes the Luhn check', () => {
    for (const c of TEST_CARDS) expect(luhn(digitsOf(c.number)), c.number).toBe(true);
  });

  it('gives each magic number its outcome', () => {
    expect(evaluateCard(card('4242 4242 4242 4242'), now)).toMatchObject({ kind: 'approved', brand: 'Visa', last4: '4242' });
    expect(evaluateCard(card('5555 5555 5555 4444'), now)).toMatchObject({ kind: 'approved', brand: 'Mastercard' });
    expect(evaluateCard(card('3782 822463 10005', { cvc: '1234' }), now)).toMatchObject({ kind: 'approved', brand: 'Amex' });
    expect(evaluateCard(card('4000 0025 0000 3155'), now).kind).toBe('challenge');
    expect(evaluateCard(card('4000 0000 0000 9995'), now)).toMatchObject({ kind: 'declined', code: 'insufficient_funds' });
    expect(evaluateCard(card('4000 0000 0000 0002'), now)).toMatchObject({ kind: 'declined', code: 'card_declined' });
    expect(evaluateCard(card('4000 0000 0000 0069'), now)).toMatchObject({ kind: 'declined', code: 'expired_card' });
    expect(evaluateCard(card('4000 0000 0000 0127'), now)).toMatchObject({ kind: 'declined', code: 'incorrect_cvc' });
    expect(evaluateCard(card('4000 0000 0000 0119'), now)).toMatchObject({ kind: 'declined', code: 'processing_error' });
  });

  it('declines other well-formed cards', () => {
    expect(evaluateCard(card('4111 1111 1111 1111'), now)).toMatchObject({ kind: 'declined', code: 'do_not_honor' });
  });

  it('rejects malformed input on the form', () => {
    expect(evaluateCard(card('4242 4242 4242 4241'), now)).toMatchObject({ kind: 'invalid', message: expect.stringContaining('number') });
    expect(evaluateCard(card('4242 4242 4242 4242', { expiry: '13/30' }), now).kind).toBe('invalid');
    expect(evaluateCard(card('4242 4242 4242 4242', { expiry: '10/26' }), now).kind).toBe('invalid');
    expect(evaluateCard(card('4242 4242 4242 4242', { expiry: '11/26' }), now).kind).toBe('approved');
    expect(evaluateCard(card('4242 4242 4242 4242', { cvc: '12' }), now).kind).toBe('invalid');
    expect(evaluateCard(card('3782 822463 10005', { cvc: '123' }), now).kind).toBe('invalid');
    expect(evaluateCard(card('4242 4242 4242 4242', { name: ' ' }), now).kind).toBe('invalid');
  });
});
