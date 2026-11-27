// 운영 제목의 오매칭을 보고 고른 단어다. 빼도 판정이 바뀌지 않는 단어는 지운다.
export type TitleWords = {
  // 이름을 품었지만 캐릭터가 아닌 단어. 이름보다 먼저 지운다.
  blockedWords: string[];
  // 낱말 경계에 있을 때만 이름으로 보는 표기. 한 글자·영문 표기는 적지 않아도 경계를 본다.
  strictBoundaryTexts: string[];
};

export const titleWords: TitleWords = {
  blockedWords: ["제미나이", "히요코", "케이크", "오디세이아", "아루지"],
  strictBoundaryTexts: [
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
    "칼학",
    "총학",
    "키키",
    "나기",
    "문주",
    "용왕",
  ],
};
