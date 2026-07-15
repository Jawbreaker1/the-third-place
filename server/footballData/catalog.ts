export const FOOTBALL_COMPETITION_IDS = ["FIFA_WC_2026"] as const;
export type FootballCompetitionId = (typeof FOOTBALL_COMPETITION_IDS)[number];

export const FOOTBALL_DATA_VIEWS = [
  "overview",
  "today",
  "recent_results",
  "upcoming",
  "standings",
] as const;
export type FootballDataView = (typeof FOOTBALL_DATA_VIEWS)[number];

export const FOOTBALL_COMPETITION_CATALOG: Record<FootballCompetitionId, {
  displayName: string;
  semanticDescription: string;
}> = {
  FIFA_WC_2026: {
    displayName: "FIFA World Cup 2026",
    semanticDescription: "the 2026 men's World Cup hosted by Canada, Mexico and the United States",
  },
};

export const isFootballCompetitionId = (value: unknown): value is FootballCompetitionId =>
  typeof value === "string" && FOOTBALL_COMPETITION_IDS.includes(value as FootballCompetitionId);

export const isFootballDataView = (value: unknown): value is FootballDataView =>
  typeof value === "string" && FOOTBALL_DATA_VIEWS.includes(value as FootballDataView);
