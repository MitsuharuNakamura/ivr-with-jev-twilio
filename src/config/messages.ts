import { describeTriage, EQUIPMENT_LABEL, SYMPTOM_LABEL, type Equipment, type Symptom, type Triage } from './serviceCatalog.js';

/**
 * Fixed utterances spoken to the caller. Kept short: every character is TTS latency.
 * Wording avoids kanji that TTS engines commonly misread (受付, 承る, 日時 …).
 */
export const MESSAGES = Object.freeze({
  welcome: 'お電話ありがとうございます。水まわりのトラブル受け付けです。どちらの、どのような症状か、お話しください。',
  askTriage: 'どちらの、どのような症状でしょうか。たとえば、キッチンの水漏れ、トイレの詰まり、などとお話しください。',
  emergencyDispatch: 'できるだけ早くお伺いします。お名前を教えてください。',
  askDatetime: 'お伺いする日にちと時間のご希望を教えてください。',
  // Spoken after the LLM remark, so the caller knows what the date question is about.
  visitIntro: 'それでは、点検と修理にお伺いします。',
  askNameAgain: 'お名前を教えてください。',
  askAddressAgain: 'お伺いする住所を教えてください。',
  restartDatetime: '失礼しました。もう一度、お伺いする日にちと時間のご希望を教えてください。',
  visitDone: 'お伺いの受け付けをしました。担当者から折り返しご連絡します。ほかにご用件はございますか。',
  askIdentifier: '受け付けの確認ですね。受け付け番号か、ご登録のお電話番号を教えてください。',
  askIdentifierAgain: '受け付け番号か、ご登録のお電話番号を、数字で教えてください。',
  faqCushion: '少々お調べしますのでお待ちください。',
  faqFailed: '申し訳ございません。ただいまお調べできませんでした。オペレーターへおつなぎすることもできます。',
  clarify: '恐れ入ります。もう一度ご用件をお聞かせいただけますか。',
  clarifyWithHint: '恐れ入ります。水漏れや詰まりなどの修理のご依頼か、料金や対処方法のご質問か、お話しいただけますか。',
  sorry: '恐れ入ります。',
  thanks: 'ありがとうございます。',
  closing: 'お電話ありがとうございました。失礼いたします。',
  handoff: '担当のオペレーターへおつなぎします。そのままお待ちください。',
  handoffAfterFailures: 'うまく聞き取れず申し訳ございません。担当のオペレーターへおつなぎします。',
  handoffUnavailable: '申し訳ございません。ただいまオペレーターにおつなぎできません。恐れ入りますが、時間をおいておかけ直しください。',
  systemError: '申し訳ございません。システムに問題が発生しました。',
});

export type MessageKey = keyof typeof MESSAGES;

/** First-aid line for an emergency, chosen by what is known about the trouble. Spoken once per call. */
export function emergencyAdvice(equipment: Equipment | undefined, symptom: Symptom | undefined): string {
  if (equipment === 'WATER_HEATER') {
    return 'まず、給湯器の使用をやめてください。ガスのにおいがする場合は、ガスの元栓を閉めて窓を開けてください。';
  }
  if (equipment === 'OUTDOOR_DRAIN' || symptom === 'CLOG') {
    return 'まず、家の中で水を流すのをやめてください。あふれた水には触らないようにしてください。';
  }
  return 'まず、水を止めましょう。器具のそばの止水栓か、家の元栓を右に回して閉めてください。';
}

/** Placeholder datetime for emergencies: the visit is scheduled as soon as possible. */
export const ASAP = 'できるだけ早く';

const EQUIPMENT_HINT = 'キッチン、トイレ、お風呂、給湯器など';
const SYMPTOM_HINT = '水漏れ、詰まり、故障など';

/** Which half of the triage is still missing decides what to ask. */
export function askTriage(equipment: Exclude<Equipment, 'UNKNOWN'> | undefined, symptom: Exclude<Symptom, 'UNKNOWN'> | undefined): string {
  if (equipment && !symptom) return `${EQUIPMENT_LABEL[equipment]}はどのような状態でしょうか。${SYMPTOM_HINT}をお聞かせください。`;
  if (symptom && !equipment) return `どちらの${SYMPTOM_LABEL[symptom]}でしょうか。${EQUIPMENT_HINT}をお聞かせください。`;
  return MESSAGES.askTriage;
}

/** 「キッチンの水漏れですね。ご希望の日にちと時間を教えてください。」 */
export const acknowledgeTriage = (triage: Triage): string => `${describeTriage(triage)}ですね。`;

export const askName = (datetime: string): string => `${datetime}ですね。お名前を教えてください。`;

export const askAddress = (name: string): string => `${name}様ですね。お伺いする住所を教えてください。`;

export const confirmVisit = (triage: Triage, datetime: string, name: string, address: string): string =>
  `${describeTriage(triage)}で、${datetime}、${name}様、${address}にお伺いします。よろしいですか。`;

/** Digits are read one by one so TTS does not turn them into a quantity. */
export const statusResult = (identifier: string): string =>
  `番号、${Array.from(identifier).join('、')}ですね。お伺いの予定は登録されています。ほかにご用件はございますか。`;
