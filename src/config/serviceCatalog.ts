/**
 * What the business repairs, as the vocabulary Jev judges with and the table
 * that turns a (equipment, symptom) judgment into one of the four service lines.
 * Jev never picks the service line itself: 「トイレの水漏れ」 is plumbing while
 * 「トイレ本体の交換」 is remodeling, so the line follows from the combination.
 */

export const EQUIPMENT = [
  'FAUCET',
  'KITCHEN',
  'TOILET',
  'BATH',
  'WASHSTAND',
  'WATER_HEATER',
  'OUTDOOR_DRAIN',
  'WASHLET',
  'UNKNOWN',
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

export const SYMPTOM = ['LEAK', 'CLOG', 'BREAKDOWN', 'REPLACE', 'CLEANING', 'UNKNOWN'] as const;
export type Symptom = (typeof SYMPTOM)[number];

export const CATEGORIES = ['WATER', 'HEATER', 'DRAINAGE', 'REMODEL'] as const;
export type Category = (typeof CATEGORIES)[number];

type Known<T> = Exclude<T, 'UNKNOWN'>;

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  WATER: '水道の修理',
  HEATER: '給湯器の修理',
  DRAINAGE: '排水の修理',
  REMODEL: '水栓・トイレのリフォーム',
};

/** Spoken labels: short, and free of kanji that TTS engines tend to misread. */
export const EQUIPMENT_LABEL: Readonly<Record<Known<Equipment>, string>> = {
  FAUCET: '蛇口',
  KITCHEN: 'キッチン',
  TOILET: 'トイレ',
  BATH: 'お風呂',
  WASHSTAND: '洗面台',
  WATER_HEATER: '給湯器',
  OUTDOOR_DRAIN: '屋外の排水',
  WASHLET: 'ウォシュレット',
};

export const SYMPTOM_LABEL: Readonly<Record<Known<Symptom>, string>> = {
  LEAK: '水漏れ',
  CLOG: '詰まり',
  BREAKDOWN: '故障',
  REPLACE: '交換',
  CLEANING: '高圧洗浄',
};

/** Choice criteria sent to Jev. Examples are in Japanese because the callers speak it. */
export const EQUIPMENT_CRITERIA: Readonly<Record<Equipment, string>> = {
  FAUCET: 'A tap / faucet / mixing valve itself (蛇口, 水栓, カラン), wherever it is installed.',
  KITCHEN: 'Kitchen sink, kitchen drain or under-sink pipes (キッチン, 台所, シンク, 流し).',
  TOILET: 'Toilet bowl, tank or toilet drain (トイレ, 便器, タンク). Not the bidet seat.',
  BATH: 'Bathroom / bathtub / shower (お風呂, 浴室, 浴槽, シャワー).',
  WASHSTAND: 'Bathroom sink / vanity unit (洗面台, 洗面所).',
  WATER_HEATER: 'Gas water heater, electric water heater or heat-pump unit (給湯器, 湯沸かし器, 電気温水器, エコキュート). Also "no hot water".',
  OUTDOOR_DRAIN: 'Outdoor drainage, inspection chamber / drain pit, sewer pipe (屋外の排水, 排水マス, 下水, 排水管の外).',
  WASHLET: 'Bidet toilet seat (ウォシュレット, 温水洗浄便座, シャワートイレ).',
  UNKNOWN: 'No equipment or location is mentioned, or it cannot be told from the utterance.',
};

export const SYMPTOM_CRITERIA: Readonly<Record<Symptom, string>> = {
  LEAK: 'Water leaking, dripping, spraying or not stopping (水漏れ, 漏れる, ポタポタ, 水が止まらない).',
  CLOG: 'Blocked or draining slowly, overflowing, backing up (詰まり, 流れない, あふれる, 逆流).',
  BREAKDOWN: 'Not working, error code, no hot water, strange noise (故障, 動かない, エラー, お湯が出ない, 異音).',
  REPLACE: 'Wants a unit replaced, newly installed or renovated (交換, 取り付け, 新しくしたい, リフォーム).',
  CLEANING: 'Wants pipes cleaned / high-pressure washing (高圧洗浄, 洗浄, 掃除してほしい).',
  UNKNOWN: 'No symptom or request is described, or it cannot be told from the utterance.',
};

/** Complete triage: both judgments known. */
export interface Triage {
  readonly equipment: Known<Equipment>;
  readonly symptom: Known<Symptom>;
}

const REMODEL_EQUIPMENT: ReadonlySet<Equipment> = new Set(['TOILET', 'WASHLET', 'WASHSTAND', 'FAUCET']);

/** Business rule: which service line handles this job. Kept in code, not in the model. */
export function categoryOf({ equipment, symptom }: Triage): Category {
  if (equipment === 'WATER_HEATER') return 'HEATER';
  if (equipment === 'OUTDOOR_DRAIN' || symptom === 'CLEANING') return 'DRAINAGE';
  if (symptom === 'REPLACE' && REMODEL_EQUIPMENT.has(equipment)) return 'REMODEL';
  return 'WATER';
}

/** 「キッチンの水漏れ」 */
export function describeTriage({ equipment, symptom }: Triage): string {
  return `${EQUIPMENT_LABEL[equipment]}の${SYMPTOM_LABEL[symptom]}`;
}

export const isKnownEquipment = (value: Equipment | undefined): value is Known<Equipment> =>
  value !== undefined && value !== 'UNKNOWN';

export const isKnownSymptom = (value: Symptom | undefined): value is Known<Symptom> =>
  value !== undefined && value !== 'UNKNOWN';

/**
 * What a call-centre agent would ask next to understand the situation, before any advice.
 * At most two questions per trouble so the intake does not drag; answers are kept verbatim
 * and handed to the LLM as context for its remark.
 */
export function detailQuestions({ equipment, symptom }: Triage): readonly string[] {
  switch (symptom) {
    case 'LEAK':
      return [
        'どのあたりから漏れていますか。蛇口の先からか、根元や配管からか、教えてください。',
        '今も水は流れ続けていますか、それとも止まっていますか。',
      ];
    case 'CLOG':
      return [
        'まったく流れませんか、それともゆっくりなら流れますか。',
        '固いものを落としたなど、心当たりはありますか。',
      ];
    case 'BREAKDOWN':
      return equipment === 'WATER_HEATER'
        ? [
            'お湯はまったく出ませんか、それとも途中で止まりますか。',
            'お風呂のリモコンにエラー番号は出ていますか。出ていれば番号を教えてください。',
          ]
        : ['どのような状態か、もう少し詳しく教えてください。'];
    case 'REPLACE':
      return equipment === 'WASHLET'
        ? ['トイレにコンセントはありますか。', '新しい機器はお持ちですか、それともこちらでご用意しますか。']
        : ['今お使いの機器は、何年くらい使われていますか。', '新しい機器はお持ちですか、それともこちらでご用意しますか。'];
    case 'CLEANING':
      return ['流れが悪いなどの症状はありますか、それとも定期的な洗浄のご希望ですか。'];
  }
}
