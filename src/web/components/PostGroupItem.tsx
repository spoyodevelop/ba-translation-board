import styled from "@emotion/styled";
import type { Post, Source } from "../../shared/post";
import { sources } from "../config";
import { formatPostTime } from "../format";
import { colors } from "../theme";
import type { Badge } from "../badges";

// 제목 옆이 붐비지 않도록 앞의 두 개만 보여 주고 나머지는 숫자로 줄인다.
const visibleBadgeCount = 2;

// 묶음에 실린 원작의 작가다. 목록 전체에서 이 작가의 묶음 수와 팔로우 여부를 함께 보여 준다.
export type GroupArtist = {
  key: string;
  name: string;
  groupCount: number;
  followed: boolean;
};

type Props = {
  posts: Post[];
  artists: GroupArtist[];
  selectedArtist: string | null;
  onSelectArtist: (key: string) => void;
  badges: Badge[];
  selectedBadgeKey: string | null;
  onSelectBadge: (badge: Badge) => void;
  visitedPostIds: Set<string>;
  onOpenPost: (post: Post) => void;
};

const sourceOrder: Record<Source, number> = { dc: 0, arca: 1 };

export function PostGroupItem({
  posts,
  artists,
  selectedArtist,
  onSelectArtist,
  badges,
  selectedBadgeKey,
  onSelectBadge,
  visitedPostIds,
  onOpenPost,
}: Props) {
  const representative = posts[0];
  const links = [...posts].sort((a, b) => {
    const sourceDifference = sourceOrder[a.source] - sourceOrder[b.source];
    return (
      sourceDifference || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
    );
  });
  const anyVisited = posts.some((post) => visitedPostIds.has(post.id));
  const singlePost = posts.length === 1 ? representative : undefined;
  const hiddenBadges = badges.slice(visibleBadgeCount);
  const chipCount =
    Math.min(badges.length, visibleBadgeCount) +
    (hiddenBadges.length > 0 ? 1 : 0) +
    artists.length;

  return (
    <Group $grouped={posts.length > 1} $visited={anyVisited}>
      <TitleRow>
        <ContentTitle $visited={anyVisited}>
          {singlePost ? (
            <TitleLink
              href={singlePost.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onOpenPost(singlePost)}
              onAuxClick={(event) => {
                if (event.button === 1) onOpenPost(singlePost);
              }}
            >
              {singlePost.title}
            </TitleLink>
          ) : (
            representative.title
          )}
        </ContentTitle>
        <Chips $ownLineOnMobile={chipCount >= 2}>
          {badges.slice(0, visibleBadgeCount).map((badge) => (
            <BadgeChip
              key={badge.key}
              $kind={badge.kind}
              type="button"
              aria-pressed={badge.key === selectedBadgeKey}
              title={`${badge.name} 글 모아보기`}
              onClick={() => onSelectBadge(badge)}
            >
              {badge.name}
            </BadgeChip>
          ))}
          {hiddenBadges.length > 0 && (
            <HiddenBadges title={hiddenBadges.map((badge) => badge.name).join(", ")}>
              +{hiddenBadges.length}
            </HiddenBadges>
          )}
          {artists.map((artist) => (
            <ArtistChip
              key={artist.key}
              type="button"
              aria-pressed={artist.key === selectedArtist}
              title={`${artist.name} 작가의 작품 모아보기`}
              onClick={() => onSelectArtist(artist.key)}
            >
              {artist.followed && <Star aria-label="팔로우 중">★</Star>}
              {artist.name}
              {artist.groupCount > 1 && <span>{artist.groupCount}</span>}
            </ArtistChip>
          ))}
        </Chips>
      </TitleRow>
      <SourceLinks>
        {links.map((post) => {
          const visited = visitedPostIds.has(post.id);
          return (
            <SourceRow key={post.id}>
              <SourceLink
                $visited={visited}
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onOpenPost(post)}
                onAuxClick={(event) => {
                  if (event.button === 1) onOpenPost(post);
                }}
                title={post.title}
                aria-label={`${sources[post.source].label} 원문: ${post.title}`}
              >
                <Branch aria-hidden="true">└</Branch>
                <SourceBadge $source={post.source}>
                  {sources[post.source].label}
                </SourceBadge>
                <PostMeta>
                  {post.author && `${post.author} · `}
                  <time
                    dateTime={post.publishedAt}
                    title={new Date(post.publishedAt).toLocaleString("ko-KR")}
                  >
                    {formatPostTime(post.publishedAt)}
                  </time>
                  {post.viewCount != null &&
                    ` · 조회 ${post.viewCount.toLocaleString()}`}
                  {post.recommendCount != null &&
                    ` · 추천 ${post.recommendCount.toLocaleString()}`}
                </PostMeta>
              </SourceLink>
            </SourceRow>
          );
        })}
      </SourceLinks>
    </Group>
  );
}

const Group = styled.article<{ $grouped: boolean; $visited: boolean }>`
  padding: 17px 24px 16px;
  border-bottom: 1px solid ${colors.borderSoft};
  background: ${({ $visited }) =>
    $visited ? colors.surfaceVisited : colors.surface};
  box-shadow: ${({ $grouped }) =>
    $grouped ? `inset 3px 0 ${colors.accent}` : "none"};

  &:hover {
    background: ${({ $visited }) =>
      $visited ? "#1c1d1f" : colors.surfaceRaised};
  }

  @media (max-width: 560px) {
    padding: 15px 16px 14px;
  }
`;

// 칩을 제목 밖에 두어 제목의 접근성 이름에 작가가 섞이지 않게 한다. 긴 제목이면 칩은 다음 줄로 내려간다.
const TitleRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 0 0 9px;
`;

// 데스크톱에서는 칩이 제목 옆에 이어 붙는다. 모바일에서 뱃지와 작가 칩이 합쳐 둘 이상이면 하나만
// 제목 옆에 남고 나머지가 다음 줄로 갈라지지 않도록 칩 전체를 다음 줄로 내린다.
const Chips = styled.div<{ $ownLineOnMobile: boolean }>`
  display: contents;

  @media (max-width: 560px) {
    ${({ $ownLineOnMobile }) =>
      $ownLineOnMobile &&
      `
      display: flex;
      flex-basis: 100%;
      flex-wrap: wrap;
      /* 제목과 칩 줄이 붙어 보이지 않도록 줄 간격(4px)에 더 띄운다. */
      margin-top: 4px;
      align-items: baseline;
      gap: 4px 8px;
    `}
  }
`;

const ContentTitle = styled.h3<{ $visited: boolean }>`
  margin: 0;
  color: ${({ $visited }) => ($visited ? colors.textVisited : colors.text)};
  font-size: 15px;
  font-weight: ${({ $visited }) => ($visited ? 500 : 650)};
  line-height: 1.45;
`;

const ArtistChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid ${colors.border};
  border-radius: 999px;
  background: transparent;
  color: ${colors.textMuted};
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;

  span {
    color: ${colors.disabled};
    font-size: 11px;
  }
  &:hover,
  &[aria-pressed="true"] {
    border-color: ${colors.accent};
    color: ${colors.textStrong};
  }
`;

// 작가 칩과 구별되도록 테두리 대신 옅은 배경을 쓰고, 단체는 캐릭터와 다른 색을 쓴다.
const BadgeChip = styled.button<{ $kind: Badge["kind"] }>`
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: ${({ $kind }) => ($kind === "group" ? colors.dcBadge : colors.arcaBadge)};
  color: ${({ $kind }) => ($kind === "group" ? colors.dcBadgeText : colors.arcaBadgeText)};
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  cursor: pointer;

  &:hover,
  &[aria-pressed="true"] {
    border-color: ${colors.accent};
    color: ${colors.textStrong};
  }
`;

// 숨긴 뱃지 이름은 마우스를 올리면 보인다.
const HiddenBadges = styled.span`
  color: ${colors.textMuted};
  font-size: 12px;
  font-weight: 600;
`;

const Star = styled.b`
  color: ${colors.accent};
  font-size: 11px;
  font-weight: 700;
`;

const TitleLink = styled.a`
  color: inherit;
  text-decoration: none;

  &:visited {
    color: ${colors.textVisited};
  }
  &:hover {
    color: ${colors.textStrong};
  }
`;

const SourceLinks = styled.div`
  display: grid;
  gap: 4px;
`;

const SourceRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  > a {
    flex: 1;
  }
`;

const SourceLink = styled.a<{ $visited: boolean }>`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  border-radius: 6px;
  padding: 3px 5px 3px 1px;
  color: ${colors.textMuted};
  opacity: ${({ $visited }) => ($visited ? 0.58 : 1)};
  text-decoration: none;

  /* Browsers allow visited colors, but not opacity or parent/group styling. */
  &:visited {
    color: ${colors.textVisited};
  }
  &:visited > span {
    color: ${colors.textVisited};
  }

  &:hover {
    color: ${colors.textStrong};
    background: rgb(255 255 255 / 0.035);
  }
`;

const Branch = styled.span`
  width: 14px;
  flex: none;
  color: ${colors.border};
  font-size: 13px;
  text-align: right;
`;

const SourceBadge = styled.span<{ $source: Source }>`
  flex: none;
  border: 1px solid
    ${({ $source }) => ($source === "arca" ? "#4b6157" : "#555866")};
  border-radius: 5px;
  padding: 3px 6px;
  color: ${({ $source }) =>
    $source === "arca" ? colors.arcaBadgeText : colors.dcBadgeText};
  background: ${({ $source }) =>
    $source === "arca" ? colors.arcaBadge : colors.dcBadge};
  font-size: 10px;
  font-weight: 700;
`;

const PostMeta = styled.small`
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
