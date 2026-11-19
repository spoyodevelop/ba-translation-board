import styled from "@emotion/styled";
import { useEffect, useRef, useState } from "react";
import type { FollowedArtist } from "../personalState.ts";
import type { ArtistFilter } from "../hooks/useArtistFilter.ts";
import { colors } from "../theme";

type Props = {
  filter: ArtistFilter | null;
  // 작가 하나를 보고 있을 때 그 작가다.
  selectedArtist: FollowedArtist | null;
  followedArtists: FollowedArtist[];
  onSelect: (filter: ArtistFilter | null) => void;
  onFollow: (artist: FollowedArtist) => void;
  onUnfollow: (key: string) => void;
};

// 작가 하나 보기와 팔로우한 작가 모아 보기를 오가는 줄이다.
// 팔로우한 작가가 없고 필터도 없으면 아무것도 보이지 않는다.
export function ArtistFilterBar({
  filter,
  selectedArtist,
  followedArtists,
  onSelect,
  onFollow,
  onUnfollow,
}: Props) {
  if (filter?.kind === "artist" && selectedArtist) {
    const following = followedArtists.some((a) => a.key === selectedArtist.key);
    return (
      <Bar>
        <span>
          <strong>{selectedArtist.name}</strong> 작가의 작품만 보는 중
        </span>
        <Actions>
          <button
            type="button"
            aria-pressed={following}
            onClick={() => {
              if (following) onUnfollow(selectedArtist.key);
              else onFollow(selectedArtist);
            }}
          >
            {following ? "★ 팔로우 중" : "☆ 팔로우"}
          </button>
          <button type="button" onClick={() => onSelect(null)}>
            전체 보기
          </button>
        </Actions>
      </Bar>
    );
  }
  if (filter?.kind === "followed") {
    return (
      <Bar>
        <Summary>
          <Label>
            {followedArtists.length === 0 && "팔로우한 작가가 없어요."}
            {followedArtists.length > 0 && (
              <>
                <strong>팔로우한 작가 {followedArtists.length}명</strong>의
                작품만 보는 중
              </>
            )}
          </Label>
          <FollowedChips artists={followedArtists} onSelect={onSelect} />
        </Summary>
        <Actions>
          <button type="button" onClick={() => onSelect(null)}>
            전체 보기
          </button>
        </Actions>
      </Bar>
    );
  }
  if (filter === null && followedArtists.length > 0) {
    return (
      <Bar>
        <Summary>
          <Label>★ 팔로우한 작가 {followedArtists.length}명</Label>
          <FollowedChips artists={followedArtists} onSelect={onSelect} />
        </Summary>
        <Actions>
          <button type="button" onClick={() => onSelect({ kind: "followed" })}>
            팔로우한 작가만 보기
          </button>
        </Actions>
      </Bar>
    );
  }
  return null;
}

// 팔로우한 작가가 많아도 줄 높이가 늘지 않도록 한 줄로 두고 가로로 스크롤한다.
// 데스크톱 스크롤바는 칩을 가리므로 숨기고, 가려진 쪽 끝을 흐리게 해 더 있다는 것을 알린다.
function FollowedChips({
  artists,
  onSelect,
}: {
  artists: FollowedArtist[];
  onSelect: (filter: ArtistFilter) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ start: false, end: false });
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const update = () => {
      const maxScroll = row.scrollWidth - row.clientWidth;
      setHidden({ start: row.scrollLeft > 1, end: row.scrollLeft < maxScroll - 1 });
    };
    // 가로 휠이 없는 마우스도 넘길 수 있게 세로 휠을 가로 스크롤로 바꾼다. 끝에 닿으면 페이지가 스크롤된다.
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const maxScroll = row.scrollWidth - row.clientWidth;
      const atEdge =
        (event.deltaY < 0 && row.scrollLeft <= 0) ||
        (event.deltaY > 0 && row.scrollLeft >= maxScroll - 1);
      if (maxScroll <= 0 || atEdge) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    update();
    const resize = new ResizeObserver(update);
    resize.observe(row);
    row.addEventListener("scroll", update, { passive: true });
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      resize.disconnect();
      row.removeEventListener("scroll", update);
      row.removeEventListener("wheel", onWheel);
    };
  }, [artists]);
  if (artists.length === 0) return null;
  return (
    <Chips
      ref={ref}
      aria-label="팔로우한 작가"
      $fadeStart={hidden.start}
      $fadeEnd={hidden.end}
    >
      {artists.map((artist) => (
        <button
          key={artist.key}
          type="button"
          title={`${artist.name} 작가의 작품만 보기`}
          onClick={() => onSelect({ kind: "artist", key: artist.key })}
        >
          {artist.name}
        </button>
      ))}
    </Chips>
  );
}

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 24px;
  border-bottom: 1px solid ${colors.border};
  background: ${colors.surfaceRaised};
  color: ${colors.textMuted};
  font-size: 14px;

  strong {
    color: ${colors.textStrong};
  }
  button {
    flex: none;
    padding: 6px 10px;
    border: 1px solid ${colors.border};
    border-radius: 6px;
    background: ${colors.button};
    color: ${colors.textStrong};
    font: inherit;
    cursor: pointer;
  }
  button[aria-pressed="true"] {
    border-color: ${colors.accent};
  }

  @media (max-width: 560px) {
    padding: 10px 16px;
  }
`;

const Actions = styled.div`
  display: flex;
  flex: none;
  gap: 6px;
`;

const Summary = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;

  @media (max-width: 560px) {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
`;

const Label = styled.span`
  flex: none;
`;

const fadeWidth = "28px";

const Chips = styled.div<{ $fadeStart: boolean; $fadeEnd: boolean }>`
  display: flex;
  flex: 1;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 ${({ $fadeStart }) => ($fadeStart ? fadeWidth : "0px")},
    #000 calc(100% - ${({ $fadeEnd }) => ($fadeEnd ? fadeWidth : "0px")}),
    transparent 100%
  );

  &::-webkit-scrollbar {
    display: none;
  }

  button {
    flex: none;
    padding: 2px 8px;
    border-radius: 999px;
    background: transparent;
    color: ${colors.textMuted};
    font-size: 12px;
    white-space: nowrap;
  }
  button:hover {
    border-color: ${colors.accent};
    color: ${colors.textStrong};
  }
`;
