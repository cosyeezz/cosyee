import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTitlebarTwoFaButton,
  hasCosyeeTitlebar,
  syncInjectedTitlebarState,
} from './titlebarCompat';

afterEach(() => {
  document.documentElement.removeAttribute('data-cosyee-titlebar');
  document.querySelectorAll('cosyee-titlebar').forEach((el) => el.remove());
});

describe('titlebarCompat', () => {
  it('returns false when no titlebar exists', () => {
    expect(hasCosyeeTitlebar()).toBe(false);
    expect(ensureTitlebarTwoFaButton(false)).toBe(false);
  });

  it('detects old titlebar without data-cosyee-titlebar and injects #t before #b idempotently', () => {
    const host = document.createElement('cosyee-titlebar');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<div class="bar"><div class="tools"><button class="ib" id="b"></button></div></div>';
    document.documentElement.appendChild(host);

    expect(hasCosyeeTitlebar()).toBe(true);
    expect(ensureTitlebarTwoFaButton(false)).toBe(true);
    // 幂等重复调用不会注入第二个按钮
    expect(ensureTitlebarTwoFaButton(true)).toBe(true);

    const tools = sr.querySelector('.tools')!;
    const buttons = Array.from(tools.querySelectorAll('button'));
    expect(buttons.map((b) => b.id)).toEqual(['t', 'b']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(sr.querySelectorAll('#__cosyee_twofa_compat_style').length).toBe(1);

    const spy = vi.fn();
    window.addEventListener('cosyee:2fa', spy);
    buttons[0]!.click();
    window.removeEventListener('cosyee:2fa', spy);
    expect(spy).toHaveBeenCalledTimes(1);

    syncInjectedTitlebarState(false);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('does nothing when new titlebar already has native #t', () => {
    document.documentElement.dataset.cosyeeTitlebar = '1';
    const host = document.createElement('cosyee-titlebar');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<div class="bar"><div class="tools"><button class="ib" id="t"></button><button class="ib" id="b"></button></div></div>';
    document.documentElement.appendChild(host);

    expect(hasCosyeeTitlebar()).toBe(true);
    expect(ensureTitlebarTwoFaButton(true)).toBe(true);

    const buttons = Array.from(sr.querySelectorAll('.tools button'));
    expect(buttons.map((b) => b.id)).toEqual(['t', 'b']);
    expect(buttons[0]!.getAttribute('data-cosyee-injected')).toBeNull();
    expect(sr.getElementById('__cosyee_twofa_compat_style')).toBeNull();
  });
});
