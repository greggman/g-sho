-- Accounts, the sign-in identities linked to them, and sessions.
-- Study data lives elsewhere (one Durable Object per user; see DESIGN-SERVER.md).

CREATE TABLE users (
  id TEXT PRIMARY KEY,               -- random, base64url
  name TEXT NOT NULL,                -- display name
  created_at INTEGER NOT NULL        -- ms since epoch
);

-- A way to sign in: (provider, subject) is the provider's stable user ID,
-- e.g. ('github', '12345').
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login TEXT,                        -- username at the provider, at last sign-in
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- Only the SHA-256 of the session token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
