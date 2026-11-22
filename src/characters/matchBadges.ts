import type { Character, CharacterAlias } from "./characterList";
import type { Club } from "./clubList";
import type { TitleWords } from "./titleWords";

// 낱말의 경계를 볼 때 이름 뒤에 올 수 있는 글자다. 조사와 호칭만 받아서 "버린", "기린" 같은 낱말 속 글자를 거른다.
export const nameSuffixes = "이가의은는을를와과랑도한에로쨩짱양씨";

// 지운 자리를 채우는 글자다. 글자가 아니어서 앞뒤 글자와 이어져 새 이름이 되지 않는다.
const mask = "□";

// 제목에서 찾을 표기 하나다. 커플링 별명은 캐릭터 여럿을 가리킨다.
type Term = { text: string; characterIds: string[]; clubIds: string[] };

type Pattern = Term & { needsBoundary: boolean };

// 제목에 나온 순서대로 담는다.
export type TitleBadges = { characterIds: string[]; clubIds: string[] };

export type BadgeMatcher = (title: string) => TitleBadges;

// 캐릭터와 단체 이름을 한 번에 찾아야 긴 이름이 먼저 지워진다. 예: 아리우스 스쿼드 속 아리우스
export function createBadgeMatcher(options: {
  characters: Character[];
  aliases: CharacterAlias[];
  clubs: Club[];
  words: TitleWords;
}): BadgeMatcher {
  const { blockedWords, strictBoundaryTexts } = options.words;
  const terms = [
    ...characterTerms(options.characters),
    ...options.aliases.map(({ text, characterIds }) => ({ text, characterIds, clubIds: [] })),
    ...options.clubs.flatMap(({ id, texts }) =>
      texts.map((text) => ({ text, characterIds: [], clubIds: [id] })),
    ),
  ];
  // 긴 표기부터 찾아야 짧은 이름이 긴 이름의 일부로 잡히지 않는다.
  const patterns: Pattern[] = terms
    .map((term) => ({ ...term, needsBoundary: needsWordBoundary(term.text, strictBoundaryTexts) }))
    .sort((a, b) => b.text.length - a.text.length);

  return (title) => {
    // 영문 단체 이름(FOX, C&C)을 대소문자 없이 찾는다.
    let text = title.normalize("NFKC").toLowerCase();
    for (const word of blockedWords) text = maskAll(text, word);

    const found: { pattern: Pattern; index: number }[] = [];
    for (const pattern of patterns) {
      const matches = findText(text, pattern);
      if (matches.length === 0) continue;
      found.push({ pattern, index: matches[0] });
      // 찾은 표기를 지워서 더 짧은 이름이 그 안에서 다시 잡히지 않게 한다. 예: 에리나 속 에리
      for (const index of matches)
        text = text.slice(0, index) + mask.repeat(pattern.text.length) + text.slice(index + pattern.text.length);
    }

    const badges: TitleBadges = { characterIds: [], clubIds: [] };
    for (const { pattern } of found.sort((a, b) => a.index - b.index)) {
      for (const id of pattern.characterIds)
        if (!badges.characterIds.includes(id)) badges.characterIds.push(id);
      for (const id of pattern.clubIds)
        if (!badges.clubIds.includes(id)) badges.clubIds.push(id);
    }
    return badges;
  };
}

// 낱말의 경계를 볼지는 여기서만 정한다. 한 글자 표기는 낱말 속에 흔히 들어 있고,
// 영문 표기는 다른 영단어 속에 들어 있기 쉽다. 나머지는 운영 제목을 보고 사람이 고른 목록을 따른다.
export function needsWordBoundary(text: string, strictBoundaryTexts: string[]): boolean {
  const isOneLetter = text.length === 1;
  const isLatin = /^[a-z&\s]+$/.test(text);
  return isOneLetter || isLatin || strictBoundaryTexts.includes(text);
}

function characterTerms(characters: Character[]): Term[] {
  const familyCounts = new Map<string, number>();
  for (const { familyName } of characters)
    if (familyName) familyCounts.set(familyName, (familyCounts.get(familyName) || 0) + 1);

  const terms: Term[] = [];
  const add = (id: string, text: string) => terms.push({ text, characterIds: [id], clubIds: [] });
  for (const { id, name, familyName } of characters) {
    add(id, name);
    if (!familyName) continue;
    add(id, `${familyName} ${name}`);
    add(id, `${familyName}${name}`);
    // 성만 쓴 제목도 있다. 짧은 성은 낱말과 겹치고, 같은 성이 여럿이면 누구인지 알 수 없어 뺀다.
    const familyOnlyIsSafe = familyName.length >= 3 && familyCounts.get(familyName) === 1;
    if (familyOnlyIsSafe) add(id, familyName);
  }
  return terms;
}

function findText(text: string, pattern: Pattern): number[] {
  const { text: name, needsBoundary } = pattern;
  const indexes: number[] = [];
  for (let index = text.indexOf(name); index >= 0; index = text.indexOf(name, index + name.length)) {
    if (!needsBoundary || isStandaloneWord(text, index, name.length)) indexes.push(index);
  }
  return indexes;
}

// 앞은 낱말의 시작, 뒤는 끝이나 조사일 때만 이름으로 본다.
function isStandaloneWord(text: string, index: number, length: number): boolean {
  const before = text[index - 1];
  const after = text[index + length];
  const startsWord = before === undefined || !isLetter(before);
  const endsWord = after === undefined || !isLetter(after) || nameSuffixes.includes(after);
  return startsWord && endsWord;
}

// 영문 단체 이름도 경계를 보므로 한글만이 아니라 모든 글자를 낱말의 일부로 본다.
function isLetter(char: string): boolean {
  return /\p{L}/u.test(char);
}

function maskAll(text: string, word: string): string {
  return text.split(word).join(mask.repeat(word.length));
}
