export const DEFAULT_SYNC_RULES = {
  schemaVersion: 1,
  autoPublish: false,
  scope: 'self',
  initialBackfillDays: 31,
  defaultPhase: 'fantasy',
  include: {
    originalText: true,
    imagePosts: true,
    videoReposts: true,
    historicalInteractions: true,
  },
  exclude: {
    emptyPosts: true,
    checkIns: true,
    applicationShares: true,
    duplicateMedia: true,
    keywords: [],
  },
  media: {
    preferOriginal: true,
    minimumImageArea: 160000,
    displayWidths: [480, 960, 1600],
  },
  safety: {
    quarantineUnknownVisibility: true,
    quarantineParseWarnings: true,
    confirmedMissingChecks: 2,
  },
};
