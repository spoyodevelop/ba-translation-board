import type { Character, CharacterAlias } from "./characterList";
import type { Club } from "./clubList";
import type { TitleWords } from "./titleWords";

// 경계를 볼 때 이름 뒤에 와도 되는 조사·호칭.
export const nameSuffixes = "이가의은는을를와과랑도한에로쨩짱양씨님";

// 글자가 아니어서 지운 자리가 앞뒤와 이어져 새 이름이 되지 않는다.
const mask = "□";

type Term = { text: string; characterIds: string[]; clubIds: string[] };

type Pattern = Term & { needsBoundary: boolean };

export type TitleBadges = { characterIds: string[]; clubIds: string[] };

export type BadgeMatcher = (title: string) => TitleBadges;

// 캐릭터와 단체를 한 번에 찾아야 긴 이름이 먼저 지워진다.
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
  const patterns: Pattern[] = terms
    .map((term) => ({ ...term, needsBoundary: needsWordBoundary(term.text, strictBoundaryTexts) }))
    .sort((a, b) => b.text.length - a.text.length);

  return (title) => {
    let text = title.normalize("NFKC").toLowerCase();
    for (const word of blockedWords) text = maskAll(text, word);

    const found: { pattern: Pattern; index: number }[] = [];
    for (const pattern of patterns) {
      const matches = findText(text, pattern);
      if (matches.length === 0) continue;
      found.push({ pattern, index: matches[0] });
      // 에리나 속 에리처럼 짧은 이름이 다시 잡히지 않게 지운다.
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

// 낱말 경계를 볼지는 여기서만 정한다.
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
    // 짧은 성은 낱말과 겹치고, 같은 성이 여럿이면 누구인지 알 수 없다.
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

function isStandaloneWord(text: string, index: number, length: number): boolean {
  const before = text[index - 1];
  const after = text[index + length];
  const startsWord = before === undefined || !isLetter(before);
  const endsWord = after === undefined || !isLetter(after) || nameSuffixes.includes(after);
  return startsWord && endsWord;
}

function isLetter(char: string): boolean {
  return /\p{L}/u.test(char);
}

function maskAll(text: string, word: string): string {
  return text.split(word).join(mask.repeat(word.length));
}
