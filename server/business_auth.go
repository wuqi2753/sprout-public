package main

// REQ-081, REQ-080: docs/stories/v0.3.0/REQ-081-cli-business-auth.md
import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

func (store *noteStore) initializeBusinessSync() error {
	tx, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`CREATE TABLE IF NOT EXISTS server_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_id TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS subscription_api_state (subscription_id TEXT PRIMARY KEY REFERENCES workspace_subscriptions(subscription_id),state TEXT NOT NULL CHECK(json_valid(state)));
 CREATE TABLE IF NOT EXISTS subscription_requests (owner_id TEXT NOT NULL,request_key TEXT NOT NULL,tags TEXT NOT NULL,subscription_id TEXT NOT NULL REFERENCES workspace_subscriptions(subscription_id),PRIMARY KEY(owner_id,request_key));
 DROP TRIGGER IF EXISTS workspace_subscription_identity_fixed;
 CREATE TRIGGER workspace_subscription_identity_fixed BEFORE UPDATE OF subscription_id,owner_id ON workspace_subscriptions
 WHEN NEW.subscription_id IS NOT OLD.subscription_id OR NEW.owner_id IS NOT OLD.owner_id BEGIN SELECT RAISE(ABORT,'subscription identity is fixed'); END;`); err != nil {
		return err
	}
	owner, err := randomOAuthSecret()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT OR IGNORE INTO server_identity VALUES(1,?)`, owner); err != nil {
		return err
	}
	return tx.Commit()
}

func singleBearer(r *http.Request) bool {
	return len(r.Header.Values("Authorization")) == 1 && r.Header.Get("X-API-Key") == "" && strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && len(strings.Fields(r.Header.Get("Authorization"))) == 2
}

func (store *noteStore) authenticateBusiness(w http.ResponseWriter, r *http.Request, scopes ...string) (string, bool) {
	invalid := func() (string, bool) {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeAPIError(w, 401, "invalid_token", "valid Access Token is required")
		return "", false
	}
	if !singleBearer(r) {
		return invalid()
	}
	var kind, scope, client, owner string
	var expiry, deadline int64
	var active, revoked int
	err := store.database.QueryRowContext(r.Context(), `SELECT t.kind,t.expires_at,t.active,g.scope,g.client_id,g.expires_at,g.revoked,i.owner_id FROM oauth_tokens t JOIN oauth_grants g ON t.grant_id=g.grant_id CROSS JOIN server_identity i WHERE t.token_hash=? AND i.singleton=1`, tokenHash(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))).Scan(&kind, &expiry, &active, &scope, &client, &deadline, &revoked, &owner)
	if errors.Is(err, sql.ErrNoRows) {
		return invalid()
	}
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to validate authorization")
		return "", false
	}
	if kind != "access_token" || active != 1 || revoked != 0 || client != cliClientID || store.now().Unix() >= expiry || store.now().Unix() >= deadline {
		return invalid()
	}
	if owner == "" {
		writeAPIError(w, 500, "database_error", "stored owner is invalid")
		return "", false
	}
	available := strings.Fields(scope)
	for _, required := range scopes {
		found := false
		for _, value := range available {
			if value == required {
				found = true
			}
		}
		if !found {
			w.Header().Set("WWW-Authenticate", `Bearer error="insufficient_scope"`)
			writeAPIError(w, 403, "insufficient_scope", "required scope is missing")
			return "", false
		}
	}
	return owner, true
}

func (store *noteStore) authenticateAttachment(w http.ResponseWriter, r *http.Request, apiKey, table, column, id string) bool {
	if singleBearer(r) && authenticate(r, apiKey) {
		return true
	}
	if _, ok := store.authenticateBusiness(w, r, "notes:read"); !ok {
		return false
	}
	if r.Method != http.MethodGet {
		writeAPIError(w, 403, "insufficient_scope", "OAuth cannot write attachments")
		return false
	}
	var count int
	// All notes on this single-user Server belong to server_identity.
	err := store.database.QueryRowContext(r.Context(), `SELECT count(*) FROM `+table+` a JOIN notes n ON n.note_id=a.note_id WHERE a.`+column+`=? AND n.deleted_at IS NULL`, id).Scan(&count)
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to check active attachment references")
		return false
	}
	if count == 0 {
		writeAPIError(w, 404, "attachment_not_found", "attachment has no readable active reference")
		return false
	}
	return true
}
