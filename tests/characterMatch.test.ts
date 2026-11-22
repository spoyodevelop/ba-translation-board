import assert from "node:assert/strict";
import { test } from "node:test";
import { characters } from "../src/characters/characterList.ts";
import { createCharacterMatcher } from "../src/characters/matchCharacters.ts";

const match = createCharacterMatcher(characters);

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
  assert.deepEqual(match("핫산) 링고 클럽 - 세미나는 트릭하고 싶어"), []);
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
  assert.deepEqual(match("핫산) 니야니야 교수의 말랑말랑 척도는?"), []);
});

test("blocked words keep popular names that also appear inside words", () => {
  assert.deepEqual(match("핫산) 아이리와 한정 케이크"), ["airi"]);
  assert.deepEqual(match("핫산) 배변패드를 들킨 케이쨩"), ["kei"]);
  assert.deepEqual(match("길을 잃고 오디세이아 배에 들어온 고양이 히나 쨩"), ["hina"]);
});

test("each character appears once in title order", () => {
  assert.deepEqual(match("나츠 카즈사 아~앙 나츠"), ["natsu", "kazusa"]);
});
