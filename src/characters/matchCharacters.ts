import type { Character } from "./characterList";

// 캐릭터 이름을 품고 있지만 캐릭터를 가리키지 않는 흔한 단어다. 이름보다 먼저 지운다.
// 운영 제목에서 잘못 잡힌 예를 보고 더한다. 예: 냥카이브(카이), 레이싱(레이), 세미나(미나)
export const defaultBlockedWords = [
  "카이브",
  "카이텐",
  "플레이",
  "레이싱",
  "레이스",
  "레이지",
  "세미나",
  "제미나이",
  "프라나",
  "히요코",
  // 동물을 세는 "한 마리"다.
  "한 마리",
  "두 마리",
  "세 마리",
  "네 마리",
  "한마리",
  "두마리",
  "세마리",
  "네마리",
];

// 한 글자 이름 뒤에 올 수 있는 글자다. 조사와 호칭만 받아서 "버린", "기린" 같은 낱말 속 글자를 거른다.
const nameSuffixes = "이가의은는을를와과랑도한에쨩짱양씨";

// 지운 자리를 채우는 글자다. 한글이 아니어서 앞뒤 글자와 이어져 새 이름이 되지 않는다.
const mask = "□";

type Pattern = { characterId: string; text: string };

export type CharacterMatcher = (title: string) => string[];

// 제목에 이름이 나오는 캐릭터의 id를 제목에 나온 순서로 돌려준다.
export function createCharacterMatcher(
  characters: Character[],
  blockedWords: string[] = defaultBlockedWords,
): CharacterMatcher {
  const patterns = buildPatterns(characters);
  return (title) => {
    let text = title.normalize("NFKC");
    for (const word of blockedWords) text = maskAll(text, word);

    const found: { characterId: string; index: number }[] = [];
    for (const pattern of patterns) {
      const matches = findName(text, pattern.text);
      if (matches.length === 0) continue;
      found.push({ characterId: pattern.characterId, index: matches[0] });
      // 찾은 이름을 지워서 더 짧은 이름이 그 안에서 다시 잡히지 않게 한다. 예: 에리나 속 에리
      for (const index of matches)
        text = text.slice(0, index) + mask.repeat(pattern.text.length) + text.slice(index + pattern.text.length);
    }

    const ids: string[] = [];
    for (const { characterId } of found.sort((a, b) => a.index - b.index))
      if (!ids.includes(characterId)) ids.push(characterId);
    return ids;
  };
}

// 긴 패턴부터 찾아야 짧은 이름이 긴 이름의 일부로 잡히지 않는다.
function buildPatterns(characters: Character[]): Pattern[] {
  const familyCounts = new Map<string, number>();
  for (const { familyName } of characters)
    if (familyName) familyCounts.set(familyName, (familyCounts.get(familyName) || 0) + 1);

  const patterns: Pattern[] = [];
  for (const character of characters) {
    const { id, name, familyName } = character;
    patterns.push({ characterId: id, text: name });
    if (!familyName) continue;
    patterns.push({ characterId: id, text: `${familyName} ${name}` });
    patterns.push({ characterId: id, text: `${familyName}${name}` });
    // 성만 쓴 제목도 있다. 짧은 성은 낱말과 겹치고, 같은 성이 여럿이면 누구인지 알 수 없어 뺀다.
    const familyOnlyIsSafe =
      familyName.length >= 3 && familyCounts.get(familyName) === 1;
    if (familyOnlyIsSafe) patterns.push({ characterId: id, text: familyName });
  }
  return patterns.sort((a, b) => b.text.length - a.text.length);
}

function findName(text: string, name: string): number[] {
  const indexes: number[] = [];
  for (let index = text.indexOf(name); index >= 0; index = text.indexOf(name, index + name.length)) {
    if (name.length > 1 || isStandaloneSyllable(text, index)) indexes.push(index);
  }
  return indexes;
}

// 한 글자 이름은 낱말 속에 흔히 들어 있어서 앞은 낱말의 시작, 뒤는 끝이나 조사일 때만 이름으로 본다.
function isStandaloneSyllable(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index + 1];
  const startsWord = before === undefined || !isHangul(before);
  const endsWord =
    after === undefined || !isHangul(after) || nameSuffixes.includes(after);
  return startsWord && endsWord;
}

function isHangul(char: string): boolean {
  return /\p{Script=Hangul}/u.test(char);
}

function maskAll(text: string, word: string): string {
  return text.split(word).join(mask.repeat(word.length));
}
