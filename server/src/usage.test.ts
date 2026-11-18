import { describe, expect, it } from 'vitest';
import { parseUsage } from './usage.js';

describe('parseUsage', () => {
  it('解析 limits', () => {
    const u = parseUsage({
      rate_limits: {
        limits: [
          { kind: 'session', percent: 12.4, resets_at: 1800000000 },
          { kind: 'weekly_all', percent: 100, resets_at: 1800000000 },
          { kind: 'weekly_scoped', percent: 30, scope: { model: { display_name: 'Fable' } } },
        ],
        weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 15, allowance_percent_of_weekly: 50 }],
      },
    }, 1);
    expect(u?.limits.map((l) => [l.kind, l.percent, l.severity])).toEqual([['session', 12, 'normal'], ['weekly', 100, 'critical'], ['scoped', 30, 'normal']]);
    expect(u?.limits[1].shares).toEqual([{ model: 'Fable', percent: 15 }]);
    expect(u?.limits[2].allowance).toBe(50);
    expect(u?.limits[0].resetsAt).toBe(1800000000000);
  });
  it('无额度信息 → null', () => {
    expect(parseUsage({})).toBeNull();
    expect(parseUsage({ rate_limits: {}, rate_limits_available: false })).toBeNull();
  });
});
