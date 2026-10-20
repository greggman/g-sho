-- Each sign-in's own display name at its provider (at last sign-in), so an
-- account with several can show who it is at each. NULL until then.
ALTER TABLE identities ADD COLUMN name TEXT;
