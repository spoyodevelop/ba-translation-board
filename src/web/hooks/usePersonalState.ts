import { useEffect, useRef, useState } from "react";
import { createPersonalStateStore, personalKeys } from "../personalState.ts";
import type { FollowedArtist } from "../personalState.ts";

export function usePersonalState() {
  const [visits, setVisits] = useState(new Set<string>());
  const currentVisits = useRef(visits);
  const [followedArtists, setFollowedArtists] = useState<FollowedArtist[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    function refresh() {
      const errors: string[] = [];
      try {
        const next = createPersonalStateStore(localStorage).readVisits();
        currentVisits.current = next;
        setVisits(next);
      } catch {
        errors.push("방문 기록을 불러오지 못했어요.");
      }
      try {
        setFollowedArtists(
          createPersonalStateStore(localStorage).readFollowedArtists(),
        );
      } catch {
        errors.push("팔로우한 작가를 불러오지 못했어요.");
      }
      setError(errors.join(" ") || null);
    }
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === null || Object.values(personalKeys).includes(event.key))
      )
        refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  function markVisited(id: string) {
    let next = new Set([...currentVisits.current, id]);
    try {
      next = createPersonalStateStore(localStorage).visit(id, next);
    } catch {
      setError(
        "방문 기록을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.",
      );
    }
    currentVisits.current = next;
    setVisits(next);
  }
  function changeFollow(change: (store: ReturnType<typeof createPersonalStateStore>) => FollowedArtist[]) {
    try {
      setFollowedArtists(change(createPersonalStateStore(localStorage)));
    } catch {
      setError(
        "팔로우를 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.",
      );
    }
  }
  function follow(artist: FollowedArtist) {
    changeFollow((store) => store.follow(artist));
  }
  function unfollow(key: string) {
    changeFollow((store) => store.unfollow(key));
  }
  return {
    visits,
    followedArtists,
    markVisited,
    follow,
    unfollow,
    error,
  };
}
