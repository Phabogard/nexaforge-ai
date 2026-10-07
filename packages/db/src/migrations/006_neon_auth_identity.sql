ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_subject TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_subject_key ON users(auth_subject) WHERE auth_subject IS NOT NULL;
