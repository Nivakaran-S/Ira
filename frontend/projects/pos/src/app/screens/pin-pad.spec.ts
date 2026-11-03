import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PinPad } from './pin-pad';

@Component({
  imports: [PinPad],
  template: `<pos-pin-pad (submitted)="got.set($event)" />`,
})
class Host {
  got = signal<string | null>(null);
  pad = viewChild.required(PinPad);
}

function press(el: HTMLElement, label: string) {
  const btn = [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  if (!btn) throw new Error(`no key ${label}`);
  btn.click();
}

describe('PinPad', () => {
  it('collects 4–8 digits, masks them, and submits on Enter', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    for (const d of ['1', '2', '3']) press(el, d);
    press(el, 'Enter');
    await fixture.whenStable();
    expect(fixture.componentInstance.got()).toBeNull(); // too short
    press(el, '4');
    await fixture.whenStable();
    expect(el.querySelectorAll('.dot.filled').length).toBe(4);
    expect(el.querySelector('.dots')!.textContent).not.toMatch(/\d/);
    press(el, 'Enter');
    expect(fixture.componentInstance.got()).toBe('1234');
  });

  it('stops at 8 digits and supports backspace', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    for (let i = 0; i < 10; i++) press(el, '7');
    press(el, 'Delete last digit');
    await fixture.whenStable();
    press(el, 'Enter');
    expect(fixture.componentInstance.got()).toBe('7777777');
  });

  it('clear() empties the entry (used after a wrong PIN)', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    for (const d of ['5', '5', '5', '5']) press(el, d);
    fixture.componentInstance.pad().clear();
    await fixture.whenStable();
    expect(el.querySelectorAll('.dot.filled').length).toBe(0);
  });
});
