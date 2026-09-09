// Mirrors the fixed rank ladder in supabase/migrations/0006_points_scoring.sql
// (rank_thresholds table). Used client-side only to render progress toward
// the next rank — users.rank itself is always computed server-side.

export interface RankThreshold {
  rank: string;
  minPoints: number;
}

export const RANK_THRESHOLDS: RankThreshold[] = [
  { rank: "Intern", minPoints: 0 },
  { rank: "Analyst", minPoints: 500 },
  { rank: "Associate", minPoints: 1500 },
  { rank: "Senior Associate", minPoints: 2500 },
  { rank: "Vice President", minPoints: 4000 },
  { rank: "Senior Vice President", minPoints: 7000 },
  { rank: "Director", minPoints: 12000 },
  { rank: "Managing Director", minPoints: 25000 },
  { rank: "Partner", minPoints: 60000 },
];

export interface RankProgress {
  currentRank: string;
  nextRank: string | null;
  pointsIntoCurrent: number;
  pointsSpanToNext: number | null;
  progressFraction: number;
  isMaxRank: boolean;
}

export function getRankProgress(totalPoints: number): RankProgress {
  let currentIndex = 0;
  for (let i = 0; i < RANK_THRESHOLDS.length; i++) {
    if (totalPoints >= RANK_THRESHOLDS[i].minPoints) currentIndex = i;
  }

  const current = RANK_THRESHOLDS[currentIndex];
  const next = RANK_THRESHOLDS[currentIndex + 1] ?? null;

  if (!next) {
    return {
      currentRank: current.rank,
      nextRank: null,
      pointsIntoCurrent: totalPoints - current.minPoints,
      pointsSpanToNext: null,
      progressFraction: 1,
      isMaxRank: true,
    };
  }

  const pointsIntoCurrent = totalPoints - current.minPoints;
  const pointsSpanToNext = next.minPoints - current.minPoints;

  return {
    currentRank: current.rank,
    nextRank: next.rank,
    pointsIntoCurrent,
    pointsSpanToNext,
    progressFraction: Math.min(1, Math.max(0, pointsIntoCurrent / pointsSpanToNext)),
    isMaxRank: false,
  };
}
