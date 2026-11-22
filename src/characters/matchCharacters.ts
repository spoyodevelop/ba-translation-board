import type { Character, CharacterAlias } from "./characterList";
import type { Group } from "./groupList";

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
  "히요코",
  // 낱말 속에서도 진짜 그 캐릭터로 자주 쓰여서 경계를 엄격히 보지 않는 이름은 단어로 막는다.
  "케이크",
  "오디세이아",
  "아루지",
  "스카이",
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

// 짧고 흔한 소리여서 낱말 속에 자주 들어 있는 이름이다. 한 글자 이름처럼 낱말의 경계에 있을 때만 이름으로 본다.
// 운영 제목에서 낱말 속에 붙어 나온 경우가 거의 다 다른 단어였던 이름만 둔다. 예: 아니야(니야), 마이크로(마이)
export const defaultStrictBoundaryNames = [
  "니야",
  "마이",
  "레이",
  "오르",
  "리오",
  "피나",
  "안나",
  "니코",
  "모에",
  "카이",
];

// 경계를 엄격히 보는 이름 뒤에 올 수 있는 글자다. 조사와 호칭만 받아서 "버린", "기린" 같은 낱말 속 글자를 거른다.
const nameSuffixes = "이가의은는을를와과랑도한에로쨩짱양씨";

// 지운 자리를 채우는 글자다. 글자가 아니어서 앞뒤 글자와 이어져 새 이름이 되지 않는다.
const mask = "□";

type Pattern = {
  // 커플링 별명은 캐릭터 여럿을 가리킨다.
  characterIds: string[];
  groupIds: string[];
  text: string;
  // 낱말의 경계에 있을 때만 이름으로 볼지 정한다.
  needsBoundary: boolean;
};

// 제목에 나온 순서대로 담는다.
export type TitleBadges = { characterIds: string[]; groupIds: string[] };

export type BadgeMatcher = (title: string) => TitleBadges;

// 캐릭터와 단체 이름을 한 번에 찾아야 긴 이름이 먼저 지워진다. 예: 아리우스 스쿼드 속 아리우스
export function createBadgeMatcher(options: {
  characters: Character[];
  aliases: CharacterAlias[];
  groups: Group[];
  blockedWords?: string[];
  strictBoundaryNames?: string[];
}): BadgeMatcher {
  const blockedWords = options.blockedWords || defaultBlockedWords;
  const patterns = buildPatterns(
    options.characters,
    options.aliases,
    options.groups,
    options.strictBoundaryNames || defaultStrictBoundaryNames,
  );
  return (title) => {
    // 영문 단체 이름(FOX, C&C)을 대소문자 없이 찾는다.
    let text = title.normalize("NFKC").toLowerCase();
    for (const word of blockedWords) text = maskAll(text, word);

    const found: { pattern: Pattern; index: number }[] = [];
    for (const pattern of patterns) {
      const matches = findName(text, pattern);
      if (matches.length === 0) continue;
      found.push({ pattern, index: matches[0] });
      // 찾은 이름을 지워서 더 짧은 이름이 그 안에서 다시 잡히지 않게 한다. 예: 에리나 속 에리
      for (const index of matches)
        text = text.slice(0, index) + mask.repeat(pattern.text.length) + text.slice(index + pattern.text.length);
    }

    const badges: TitleBadges = { characterIds: [], groupIds: [] };
    for (const { pattern } of found.sort((a, b) => a.index - b.index)) {
      for (const id of pattern.characterIds)
        if (!badges.characterIds.includes(id)) badges.characterIds.push(id);
      for (const id of pattern.groupIds)
        if (!badges.groupIds.includes(id)) badges.groupIds.push(id);
    }
    return badges;
  };
}

// 긴 패턴부터 찾아야 짧은 이름이 긴 이름의 일부로 잡히지 않는다.
function buildPatterns(
  characters: Character[],
  aliases: CharacterAlias[],
  groups: Group[],
  strictBoundaryNames: string[],
): Pattern[] {
  const character = (ids: string[], text: string, needsBoundary: boolean) =>
    ({ characterIds: ids, groupIds: [], text, needsBoundary });
  const familyCounts = new Map<string, number>();
  for (const { familyName } of characters)
    if (familyName) familyCounts.set(familyName, (familyCounts.get(familyName) || 0) + 1);

  const patterns: Pattern[] = [];
  for (const { id, name, familyName } of characters) {
    const needsBoundary =
      name.length === 1 || strictBoundaryNames.includes(name);
    patterns.push(character([id], name, needsBoundary));
    if (!familyName) continue;
    // 성과 함께 쓴 이름은 길어서 낱말과 겹칠 일이 적다.
    patterns.push(character([id], `${familyName} ${name}`, false));
    patterns.push(character([id], `${familyName}${name}`, false));
    // 성만 쓴 제목도 있다. 짧은 성은 낱말과 겹치고, 같은 성이 여럿이면 누구인지 알 수 없어 뺀다.
    const familyOnlyIsSafe =
      familyName.length >= 3 && familyCounts.get(familyName) === 1;
    if (familyOnlyIsSafe)
      patterns.push(character([id], familyName, false));
  }
  // 두 글자 이하 별명은 낱말 속에 들어 있기 쉬워서 이름처럼 경계를 엄격히 본다. 예: 나기, 키키
  for (const { text, characterIds } of aliases)
    patterns.push(character(characterIds, text, text.length <= 2));
  // 영문 단체 이름은 다른 영단어 속에 들어 있기 쉬워서 경계를 엄격히 본다. 예: fox
  for (const { id, texts } of groups)
    for (const text of texts)
      patterns.push({
        characterIds: [],
        groupIds: [id],
        text,
        needsBoundary: text.length <= 2 || /^[a-z&\s]+$/.test(text),
      });
  return patterns.sort((a, b) => b.text.length - a.text.length);
}

function findName(text: string, pattern: Pattern): number[] {
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
  const endsWord =
    after === undefined || !isLetter(after) || nameSuffixes.includes(after);
  return startsWord && endsWord;
}

// 영문 단체 이름도 경계를 보므로 한글만이 아니라 모든 글자를 낱말의 일부로 본다.
function isLetter(char: string): boolean {
  return /\p{L}/u.test(char);
}

function maskAll(text: string, word: string): string {
  return text.split(word).join(mask.repeat(word.length));
}
