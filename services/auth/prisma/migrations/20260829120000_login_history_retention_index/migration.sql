-- The retention sweep selects login history by age alone. Every existing index
-- on the table leads with a different column (auth_user_id, email, ip), so none
-- of them can serve that predicate and the sweep would seq-scan the largest
-- table in the schema on every cycle.
CREATE INDEX "login_history_login_at_idx" ON "login_history"("login_at");
