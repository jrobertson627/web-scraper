BEGIN;

-- Operator review (#48). Accepting or dismissing a reconciliation issue is a
-- recorded disposition, like an operator_stop release in operator_dispositions:
-- who, when, why, and for an accept the revision that became accepted.
CREATE TABLE IF NOT EXISTS reconciliation_dispositions (
  id BIGSERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL REFERENCES reconciliation_issues(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('accept','dismiss')),
  operator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision_id BIGINT REFERENCES normalized_page_revisions(id),
  recorded_at TIMESTAMPTZ NOT NULL,
  CHECK ((disposition = 'accept') = (revision_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reconciliation_dispositions_issue_idx ON reconciliation_dispositions (issue_id);

-- When an issue was opened, for the review list. Rows from before this
-- migration take the time it ran.
ALTER TABLE reconciliation_issues ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NOT NULL DEFAULT now();

INSERT INTO schema_migrations(version) VALUES ('012_review_dispositions') ON CONFLICT (version) DO NOTHING;
COMMIT;
