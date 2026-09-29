import { describe, expect, it } from 'vitest';
import { askTriage } from '../src/config/messages.js';
import {
  categoryOf,
  describeTriage,
  EQUIPMENT,
  EQUIPMENT_CRITERIA,
  SYMPTOM,
  SYMPTOM_CRITERIA,
} from '../src/config/serviceCatalog.js';

describe('categoryOf', () => {
  it.each([
    ['KITCHEN', 'LEAK', 'WATER'],
    ['TOILET', 'CLOG', 'WATER'],
    ['FAUCET', 'LEAK', 'WATER'],
    ['BATH', 'BREAKDOWN', 'WATER'],
    ['WATER_HEATER', 'BREAKDOWN', 'HEATER'],
    ['WATER_HEATER', 'REPLACE', 'HEATER'],
    ['OUTDOOR_DRAIN', 'CLOG', 'DRAINAGE'],
    ['KITCHEN', 'CLEANING', 'DRAINAGE'],
    ['TOILET', 'REPLACE', 'REMODEL'],
    ['WASHLET', 'REPLACE', 'REMODEL'],
    ['WASHSTAND', 'REPLACE', 'REMODEL'],
    ['FAUCET', 'REPLACE', 'REMODEL'],
    ['KITCHEN', 'REPLACE', 'WATER'],
  ] as const)('%s + %s -> %s', (equipment, symptom, category) => {
    expect(categoryOf({ equipment, symptom })).toBe(category);
  });
});

describe('labels and criteria', () => {
  it('has a Jev criterion for every option, including the no-match one', () => {
    expect(Object.keys(EQUIPMENT_CRITERIA)).toEqual([...EQUIPMENT]);
    expect(Object.keys(SYMPTOM_CRITERIA)).toEqual([...SYMPTOM]);
    expect(EQUIPMENT).toContain('UNKNOWN');
    expect(SYMPTOM).toContain('UNKNOWN');
  });

  it('describes a triage in spoken Japanese', () => {
    expect(describeTriage({ equipment: 'KITCHEN', symptom: 'LEAK' })).toBe('キッチンの水漏れ');
    expect(describeTriage({ equipment: 'OUTDOOR_DRAIN', symptom: 'CLEANING' })).toBe('屋外の排水の高圧洗浄');
  });

  it('asks for the missing half of the triage', () => {
    expect(askTriage('KITCHEN', undefined)).toContain('キッチンはどのような状態');
    expect(askTriage(undefined, 'CLOG')).toContain('どちらの詰まり');
    expect(askTriage(undefined, undefined)).toContain('どちらの、どのような症状');
  });
});
