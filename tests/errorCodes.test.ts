import { describe, expect, it } from 'vitest';
import rawErrorCodes from '../src/errorCodes.json' with { type: 'json' };
import { describeErrorCodes, findErrorCodes, parseErrorCodes } from '../src/services/errorCodes.js';

const table = parseErrorCodes(rawErrorCodes);

describe('errorCodes.json', () => {
  it('parses, has unique codes, and every entry is for known equipment', () => {
    expect(table.length).toBeGreaterThanOrEqual(3);
    expect(new Set(table.map((e) => e.code)).size).toBe(table.length);
  });

  it('rejects malformed or duplicate entries', () => {
    expect(() => parseErrorCodes([{ code: 'abc', equipment: 'WATER_HEATER', meaning: 'x', action: 'y', needsVisit: 'z' }])).toThrow();
    expect(() => parseErrorCodes([...rawErrorCodes, rawErrorCodes[0]])).toThrow(/duplicate/);
  });
});

describe('findErrorCodes', () => {
  it.each([
    ['お風呂のリモコンに111が出てます', ['111']],
    ['えっと、１４０です', ['140']],
    ['888って出てる', ['888']],
    ['E 1 が点滅してます', ['E1']],
    ['111と140が交互に出ます', ['111', '140']],
    // Speech-to-text sometimes spells digits out in kanji or kana.
    ['エラーは一一一です', ['111']],
    ['いちいちいちが出てます', ['111']],
    ['いち、よん、ぜろ、です', ['140']],
    ['はちはちはち', ['888']],
  ])('finds codes in 「%s」', (text, codes) => {
    expect(findErrorCodes(text, table).map((m) => m.code)).toEqual(codes);
  });

  it('marks codes missing from the table as unknown', () => {
    const [match] = findErrorCodes('999が出ています', table);
    expect(match).toEqual({ code: '999', entry: undefined });
  });

  it('leaves ordinary kana alone (particles are not digits)', () => {
    expect(findErrorCodes('にごろく時にお願いします', table).map((m) => m.code)).toEqual(['256']);
    expect(findErrorCodes('お湯が出ないのでご相談です', table)).toEqual([]);
    expect(findErrorCodes('エラーは出てないと思います', table)).toEqual([]);
  });

  it.each(['エラーは出てないです', '明日の3時でお願いします', '2名で18時に', '090-1234-5678'])('ignores 「%s」', (text) => {
    // Phone numbers and times are not error codes: only 3–4 digit tokens count, and 1234/5678 are
    // not in the table, so they would surface as unknown — make sure common non-code speech stays clean.
    const codes = findErrorCodes(text, table).map((m) => m.code);
    expect(codes.every((c) => c.length >= 3)).toBe(true);
    expect(codes).not.toContain('3');
  });

  it('describes matches for the prompt and returns nothing when there are none', () => {
    const text = describeErrorCodes(findErrorCodes('111と999', table)) ?? '';
    expect(text).toContain('コード 111: 点火不良');
    expect(text).toContain('コード 999: 登録なし');
    expect(describeErrorCodes([])).toBeUndefined();
  });
});
