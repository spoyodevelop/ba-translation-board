// 동아리·소대처럼 여러 학생이 속한 단체다. 같은 글 묶음(PostGroup)과 헷갈리지 않게 Club이라 부른다.
export type Club = {
  // 판정 결과에 남는 값이라 이름을 고쳐도 바꾸지 않는다.
  id: string;
  // 뱃지에 보이는 이름이다.
  name: string;
  // 제목에서 찾을 표기다. 뱃지 이름도 여기 넣는다. 영문은 소문자로 적는다.
  texts: string[];
};

// 캐릭터 이름 없이 단체 이름만 쓴 운영 제목이 5번 이상 나온 단체다(2026-11-23 기준).
// 멤버로 풀지 않는다. 특별반이나 FOX 소대처럼 시기마다 멤버가 달라 틀리기 쉽고 뱃지가 늘어난다.
// 학교 이름은 "게헨나컵"처럼 행사 이름이거나 너무 넓어서 넣지 않는다.
export const clubs: Club[] = [
  { id: "game-development", name: "게임개발부", texts: ["게임개발부", "겜개부", "겜창부", "게개부"] },
  { id: "tea-party", name: "티파티", texts: ["티파티"] },
  { id: "pandemonium", name: "만마전", texts: ["만마전", "수마전"] },
  { id: "fox", name: "FOX 소대", texts: ["fox 소대", "fox소대", "폭스 소대", "폭스소대", "fox"] },
  { id: "special-class", name: "특별반", texts: ["특별반"] },
  { id: "foreclosure-task-force", name: "대책위원회", texts: ["대책위원회", "대책위"] },
  { id: "occult", name: "오컬트 연구회", texts: ["오컬트 연구회", "오컬트연구회", "오컬연"] },
  { id: "after-school-sweets", name: "방과후 디저트부", texts: ["방과후 디저트부", "디저트부", "방디부"] },
  { id: "arius-squad", name: "아리우스 스쿼드", texts: ["아리우스 스쿼드", "아리우스스쿼드", "스쿼드"] },
  { id: "prefect-team", name: "선도부", texts: ["선도부"] },
  { id: "cleaning-and-clearing", name: "C&C", texts: ["c&c"] },
  { id: "school-lunch", name: "급양부", texts: ["급양부"] },
];
