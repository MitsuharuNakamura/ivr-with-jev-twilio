/**
 * Jev judges *whether* an utterance carries a slot value; this module copies the
 * value out of the caller's own words. Nothing here is generated.
 */

const NUM = '(?:\\d{1,2}|[一二三四五六七八九十]{1,3})';
const DATETIME_TOKEN = new RegExp(
  [
    '今日|本日|明日|明後日|あした|あさって|今週|来週|再来週|今月|来月',
    `${NUM}月${NUM}日`,
    `${NUM}日`,
    '[月火水木金土日]曜日?',
    '午前中|午前|午後|朝|昼|夕方|夜',
    `${NUM}時(?:半|${NUM}分)?`,
    '\\d{1,2}[:：]\\d{2}',
  ].join('|'),
  'g',
);

const LEADING_FILLER = /^(?:えーと|えっと|えー|あのー?|あ|はい|じゃあ|では)[、,。\s]*/;
const TRAILING_POLITE =
  /(?:で(?:お願い(?:いた)?します|お願いできますか)|が(?:いい|良い)(?:です)?|と申します|といいます|と言います|です|でーす)?[。．.、,!！\s]*$/;
const NAME_PREFIX = /^(?:(?:私|わたし|名前|お名前)(?:は|の名前は)?[、,\s]*)/;
const IDENTIFIER = /\d{4,11}/;

/** Strips leading fillers and trailing politeness; used for answers kept as free text. */
export function tidy(utterance: string): string {
  return utterance.normalize('NFKC').trim().replace(LEADING_FILLER, '').replace(TRAILING_POLITE, '').trim();
}

/** "えっと、明日の３時でお願いします" -> "明日の3時". Falls back to the tidied utterance. */
export function extractDatetime(utterance: string): string {
  const text = utterance.normalize('NFKC');
  const matches = [...text.matchAll(DATETIME_TOKEN)];
  const first = matches[0];
  const last = matches.at(-1);
  if (first?.index === undefined || last?.index === undefined) return tidy(utterance);
  return text.slice(first.index, last.index + last[0].length);
}

/** "中村と申します" -> "中村" */
export function extractName(utterance: string): string {
  return tidy(utterance).replace(NAME_PREFIX, '').replace(/様$|さん$/, '').trim();
}

/** "住所は世田谷区桜丘1丁目2の3です" -> "世田谷区桜丘1丁目2の3". Kept as spoken; geocoding is not attempted. */
export function extractAddress(utterance: string): string {
  return tidy(utterance).replace(/^(?:住所は|場所は)[、,\s]*/, '').trim();
}

/** "1234-5678 です" -> "12345678"; undefined when no usable number was spoken. */
export function extractIdentifier(utterance: string): string | undefined {
  return utterance.normalize('NFKC').replace(/[\s\-ー－の、,]/g, '').match(IDENTIFIER)?.[0];
}
