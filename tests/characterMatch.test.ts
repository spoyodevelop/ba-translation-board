import assert from "node:assert/strict";
import { test } from "node:test";
import {
  characterAliases,
  characters,
} from "../src/characters/characterList.ts";
import { clubs } from "../src/characters/clubList.ts";
import {
  createBadgeMatcher,
  needsWordBoundary,
} from "../src/characters/matchBadges.ts";
import { titleWords } from "../src/characters/titleWords.ts";

const matchBadges = createBadgeMatcher({
  characters,
  aliases: characterAliases,
  clubs,
  words: titleWords,
});
const match = (title: string) => matchBadges(title).characterIds;
const matchClubs = (title: string) => matchBadges(title).clubIds;

test("longer names win over names inside them", () => {
  assert.deepEqual(match("핫산) 에리나에게 레슬링 기술 거는 안나"), ["erina", "anna"]);
  assert.deepEqual(match("핫산) 쉬운 여자 스미카"), ["sumika"]);
  assert.deepEqual(match("핫산) 같이 목욕하는 이치카와 미카"), ["ichika", "mika"]);
  assert.deepEqual(match("핫산) 쿠루미는 스고이쟈나이!"), ["kurumi"]);
  assert.deepEqual(match("핫산) 달맞이를 준비하는 프라나"), ["plana"]);
});

test("a short name still matches beside a longer one", () => {
  assert.deepEqual(match("핫산,보빔) 레나와 에리의 거리감"), ["rena", "eri"]);
});

test("family names point to the character", () => {
  assert.deepEqual(match("핫산) 소라사키 히나의 인간극장"), ["hina"]);
  assert.deepEqual(match("핫산) 사랑에 빠진 우자와 레이사.manhwa"), ["reisa"]);
});

test("common words that contain names are ignored", () => {
  assert.deepEqual(match("핫산) 냥카이브 코토네"), ["kotone"]);
  assert.deepEqual(matchBadges("핫산) 링고 클럽 - 세미나는 트릭하고 싶어"), {
    characterIds: [],
    clubIds: ["seminar"],
  });
  assert.deepEqual(match("선생이랑 레이스하고온 아즈사"), ["azusa"]);
});

test("one-syllable names need a word of their own", () => {
  assert.deepEqual(match("핫산) 외투금지령이 내려진 린쨩"), ["rin"]);
  assert.deepEqual(match("번역) 슌과 데이트"), ["shun"]);
  assert.deepEqual(match("핫산) 수상한 의뢰를 받아버린 아루사장"), ["aru"]);
  assert.deepEqual(match("핫산) 감기걸린 케이쨩"), ["kei"]);
});

test("short common-sounding names need a word of their own", () => {
  assert.deepEqual(match("번역)미카는 마녀가 아니야"), ["mika"]);
  assert.deepEqual(match("핫산) 케이쨩에게 마이크로 비키니를 부탁해봤다"), ["kei"]);
  assert.deepEqual(match("모모이 클레이로 만들어봤는데"), ["momoi"]);
  assert.deepEqual(match("핫산) 고릴라 트리오"), []);
  assert.deepEqual(match("[번역] 밀레니엄 학생들에게 리오로 오해 받는 치사"), ["rio"]);
  assert.deepEqual(match("핫산) 니야니야 교수의 말랑말랑 척도는?"), ["professor-smug"]);
});

test("a name after an adjective ending in 한 is still found", () => {
  assert.deepEqual(match("음해 ) 불량한 마리의 담배"), ["mari"]);
  assert.deepEqual(match("생일에 적적한 마리나.grim"), ["marina"]);
  assert.deepEqual(match("핫산) 유령 코스프레 한 마리"), ["mari"]);
});

test("blocked words keep popular names that also appear inside words", () => {
  assert.deepEqual(match("핫산) 아이리와 한정 케이크"), ["airi"]);
  assert.deepEqual(match("핫산) 배변패드를 들킨 케이쨩"), ["kei"]);
  assert.deepEqual(match("길을 잃고 오디세이아 배에 들어온 고양이 히나 쨩"), ["hina"]);
});

test("new students not yet on mollulog are listed", () => {
  assert.deepEqual(match("번역) 우루와시 마나미와 예술"), ["manami"]);
  assert.deepEqual(match("마나미 우라라 헤일로 모작"), ["manami", "urara"]);
  assert.deepEqual(match("키라라 그림"), ["kirara"]);
});

test("each character appears once in title order", () => {
  assert.deepEqual(match("나츠 카즈사 아~앙 나츠"), ["natsu", "kazusa"]);
});

test("aliases point to their characters", () => {
  assert.deepEqual(match("핫산) 볼 부풀리는 말랑말랑 칼학쨩"), ["kal-student-council-president"]);
  assert.deepEqual(match("핫산) 레후미 레즈사 합동모션"), ["hifumi", "azusa"]);
  assert.deepEqual(match("핫산) 무임승차를 검거한 철도가키"), ["hikari", "nozomi"]);
  assert.deepEqual(match("핫산) 나기 쨩과 고양이"), ["nagisa"]);
  assert.deepEqual(match("핫산) 한정판 케이크가 먹고 싶은 쿠로코"), ["shiroko_terror"]);
  assert.deepEqual(match("시로코 테러 그림"), ["shiroko_terror"]);
  assert.deepEqual(match("저번에 그린 니야니야교수님이에요"), ["professor-smug"]);
});

test("a longer name wins over an alias inside it", () => {
  assert.deepEqual(match("칼학생회장 때문에 멘헤라 터진 미카"), ["kal-student-council-president", "mika"]);
  assert.deepEqual(match("미카에 대한 대처법을 알아낸 나기사"), ["mika", "nagisa"]);
});

// 별명이 다른 캐릭터 이름과 같거나 막는 단어에 가려지면 그 별명은 영영 잡히지 않는다.
test("aliases point to listed characters and are not hidden", () => {
  const ids = new Set(characters.map((c) => c.id));
  const names = new Set(characters.map((c) => c.name));
  for (const alias of characterAliases) {
    for (const id of alias.characterIds) assert.ok(ids.has(id), `${alias.text}: ${id}`);
    assert.ok(!names.has(alias.text), alias.text);
    for (const word of titleWords.blockedWords) assert.ok(!word.includes(alias.text), `${alias.text} ⊂ ${word}`);
  }
});

test("club names become club badges, not member badges", () => {
  assert.deepEqual(matchBadges("핫산) 낚시하러 가는 겜창부"), {
    characterIds: [],
    clubIds: ["game-development"],
  });
  assert.deepEqual(matchClubs("핫산) 183호 특별반은 관심받고 싶어"), ["special-class"]);
  assert.deepEqual(matchClubs("핫산) 선생님을 찾는 짜리우스 스쿼드"), ["arius-squad"]);
});

test("latin club names match without case inside their own word", () => {
  assert.deepEqual(matchClubs("핫산) fox 가정부 서비스 입니다!.manhwa"), ["fox"]);
  assert.deepEqual(matchClubs("#FOX소대"), ["fox"]);
  assert.deepEqual(matchClubs("핫산) 꽃가루 때문에 고생하는 C&C ①~④"), ["cleaning-and-clearing"]);
  assert.deepEqual(matchClubs("firefox 설정"), []);
});

test("characters and clubs in one title are both found", () => {
  assert.deepEqual(matchBadges("핫산) 엔지니어부의 새 발명품을 테스트하는 게임개발부와 유즈"), {
    characterIds: ["yuzu"],
    clubIds: ["game-development"],
  });
});

test("one rule decides which texts need word boundaries", () => {
  const strict = titleWords.strictBoundaryTexts;
  assert.equal(needsWordBoundary("린", strict), true);
  assert.equal(needsWordBoundary("fox", strict), true);
  assert.equal(needsWordBoundary("니야", strict), true);
  assert.equal(needsWordBoundary("미카", strict), false);
  assert.equal(needsWordBoundary("나기사", strict), false);
});

// 두 글자 별명은 이름보다 낱말 속에 들어 있기 쉬워서 빠짐없이 경계를 봐야 한다.
test("every short alias needs a word boundary", () => {
  for (const { text } of characterAliases)
    if (text.length <= 2)
      assert.ok(needsWordBoundary(text, titleWords.strictBoundaryTexts), text);
});
