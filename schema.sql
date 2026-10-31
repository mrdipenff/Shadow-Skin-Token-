CREATE TABLE IF NOT EXISTS ticket_users (
    device_id TEXT PRIMARY KEY,
    tickets INTEGER NOT NULL DEFAULT 0 CHECK (tickets >= 0),
    last_redeem_date TEXT,
    last_redeem_code_hash TEXT,
    get_tickets_until TIMESTAMPTZ,
    submit_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_users_updated_at
ON ticket_users(updated_at);
