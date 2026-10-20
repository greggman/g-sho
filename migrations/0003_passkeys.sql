-- Passkeys (WebAuthn). Each is also an identity ('passkey', credential_id);
-- this keeps what checks its sign-ins.
CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,    -- base64url
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,          -- SPKI, base64url
  algorithm INTEGER NOT NULL,        -- COSE: -7 ES256, -257 RS256
  sign_count INTEGER NOT NULL,       -- 0 for synced passkeys
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);
