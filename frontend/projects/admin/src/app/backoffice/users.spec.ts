import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BackofficeApi } from './backoffice-api';
import { BackofficeSession } from './session';
import { Users } from './users';

describe('Users', () => {
  it('creates a user and shows the setup code once, then hides it', async () => {
    const api = {
      users: vi.fn().mockResolvedValue([]),
      roles: vi.fn().mockResolvedValue([{ id: 'r1', name: 'Cashier', permissions: ['sale.create'], requiresMfa: false, isSystem: false, _count: { users: 0 } }]),
      createUser: vi.fn().mockResolvedValue({ user: { id: 'u1', name: 'Kamal', email: 'k@a.lk', status: 'ACTIVE', roles: [], hasPin: true }, setupCode: 'SETUP-CODE-123456' }),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: BackofficeApi, useValue: api },
        { provide: BackofficeSession, useValue: { can: () => true } },
      ],
    });
    const fixture = TestBed.createComponent(Users);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    el.querySelector<HTMLButtonElement>('[data-testid="new-user"]')!.click();
    await fixture.whenStable();
    const set = (sel: string, v: string) => {
      const i = el.querySelector<HTMLInputElement>(sel)!;
      i.value = v;
      i.dispatchEvent(new Event('input'));
    };
    set('#u-name', 'Kamal');
    set('#u-email', 'k@a.lk');
    set('#u-pin', '4321');
    const box = el.querySelector<HTMLInputElement>('input[data-role="r1"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    el.querySelector<HTMLFormElement>('form[data-testid="user-form"]')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
    expect(api.createUser).toHaveBeenCalledWith({ name: 'Kamal', email: 'k@a.lk', roleIds: ['r1'], pin: '4321' });
    expect(el.textContent).toContain('SETUP-CODE-123456');
    el.querySelector<HTMLButtonElement>('[data-testid="dismiss-code"]')!.click();
    await fixture.whenStable();
    expect(el.textContent).not.toContain('SETUP-CODE-123456');
  });
});
