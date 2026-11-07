export const guards = [
  "session-brief",
  "commit-guard",
  "no-comments",
  "no-em-dash",
  "reply-guard",
] as const;

export type Guard = (typeof guards)[number];

export const rules = {
  "session-brief": [],
  "commit-guard": [
    "setting",
    "commit-shape",
    "comment-shape",
    "push",
    "unparsed",
    "message-length",
    "message-prefix",
    "message",
    "hands-off-commit",
    "hands-off-push",
    "comment-inactive",
    "push-refused",
    "comment-lines",
    "unreadable",
  ],
  "no-comments": ["comment", "unguarded", "unreadable"],
  "no-em-dash": ["dash"],
  "reply-guard": [
    "draft-blockquote",
    "draft-path",
    "draft-plan-id",
    "draft-backtick",
    "dash",
    "filler",
    "bold-label",
    "comment-lines",
  ],
} as const satisfies Record<Guard, readonly string[]>;

export type RuleId = {
  [G in Guard]: `${G}/${(typeof rules)[G][number]}`;
}[Guard];
