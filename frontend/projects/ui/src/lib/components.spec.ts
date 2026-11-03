import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiCopy } from './copy';
import { UiOtpInput } from './otp-input';
import { ToastService, UiToastHost } from './toast';

describe('UiOtpInput', () => {
  @Component({
    imports: [UiOtpInput],
    template: `<ui-otp-input (completed)="done.set($event)" />`,
  })
  class Host {
    done = signal<string | null>(null);
  }

  it('keeps digits only, caps at 6, and emits once complete', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = '12a 34';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(input.value).toBe('1234');
    expect(fixture.componentInstance.done()).toBeNull();
    input.value = '12345678';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(input.value).toBe('123456');
    expect(fixture.componentInstance.done()).toBe('123456');
  });
});

describe('UiCopy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('copies its value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fixture = TestBed.createComponent(UiCopy);
    fixture.componentRef.setInput('value', 'SECRET-CODE');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('SECRET-CODE');
    fixture.nativeElement.querySelector('button').click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith('SECRET-CODE');
    expect(fixture.nativeElement.textContent).toContain('Copied');
  });
});

describe('ToastService', () => {
  it('shows and dismisses messages', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(UiToastHost);
    const toasts = TestBed.inject(ToastService);
    toasts.error('Nope');
    toasts.success('Saved');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Nope');
    expect(fixture.nativeElement.textContent).toContain('Saved');
    vi.advanceTimersByTime(10_000);
    fixture.detectChanges();
    expect(toasts.items()).toEqual([]);
    vi.useRealTimers();
  });
});
