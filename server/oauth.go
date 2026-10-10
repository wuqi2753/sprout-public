package main

// REQ-076: docs/stories/v0.5.0/REQ-076-cli-oauth-credentials.md
import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strings"
)

const cliClientID = "sprout-cli"
const cliScope = "notes:read subscriptions:manage"
const deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"

type oauthFailure struct {
	Error       string `json:"error"`
	Description string `json:"error_description"`
}
type oauthResult struct {
	status int
	body   any
}

func oauthError(status int, code, description string) oauthResult {
	return oauthResult{status, oauthFailure{code, description}}
}

func (store *noteStore) initializeOAuth() error {
	_, err := store.database.Exec(`
 CREATE TABLE IF NOT EXISTS oauth_device_secrets (
 user_code TEXT PRIMARY KEY REFERENCES oauth_device_requests(user_code) ON DELETE CASCADE,
 device_hash TEXT NOT NULL UNIQUE, poll_interval INTEGER NOT NULL CHECK(poll_interval>=5), next_poll_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS oauth_grants (
 grant_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL,
 expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)));
 CREATE TABLE IF NOT EXISTS oauth_tokens (
 token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id),
 kind TEXT NOT NULL CHECK(kind IN ('access_token','refresh_token')), expires_at INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
 CREATE INDEX IF NOT EXISTS oauth_tokens_grant ON oauth_tokens(grant_id);`)
	return err
}

func randomOAuthSecret() (string, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(secret[:]), nil
}
func tokenHash(secret string) string {
	hash := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(hash[:])
}
func randomUserCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	code := make([]byte, 8)
	for i, b := range random {
		code[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(code[:4]) + "-" + string(code[4:]), nil
}

func parseOAuthForm(w http.ResponseWriter, r *http.Request, allowed ...string) (url.Values, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || r.URL.RawQuery != "" {
		return nil, errors.New("request must use form encoding without URL parameters")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil {
		return nil, errors.New("invalid form or body exceeds 4096 bytes")
	}
	for key, values := range r.PostForm {
		found := false
		for _, name := range allowed {
			if key == name {
				found = true
			}
		}
		if !found || len(values) != 1 {
			return nil, errors.New("unknown or repeated form field")
		}
	}
	return r.PostForm, nil
}

// Commit protocol errors too: slow_down and refresh replay change security state.
func (store *noteStore) oauthTransaction(r *http.Request, operation func(*sql.Tx) (oauthResult, error)) (result oauthResult, failure error) {
	tx, err := store.database.BeginTx(r.Context(), nil)
	if err != nil {
		return result, err
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			failure = errors.Join(failure, err)
		}
	}()
	result, failure = operation(tx)
	if failure != nil {
		return result, failure
	}
	failure = tx.Commit()
	return result, failure
}

func (store *noteStore) registerOAuthRoutes(mux *http.ServeMux) {
	for _, path := range []string{"/oauth/device_authorization", "/oauth/token", "/oauth/revoke"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Pragma", "no-cache")
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", "POST")
				writeJSON(w, 405, oauthFailure{"invalid_request", "POST is required"})
				return
			}
			allowed := []string{"client_id"}
			switch r.URL.Path {
			case "/oauth/device_authorization":
				allowed = append(allowed, "scope")
			case "/oauth/token":
				allowed = append(allowed, "grant_type", "device_code", "refresh_token")
			case "/oauth/revoke":
				allowed = append(allowed, "token", "token_type_hint")
			}
			form, err := parseOAuthForm(w, r, allowed...)
			if err != nil {
				writeJSON(w, 400, oauthFailure{"invalid_request", err.Error()})
				return
			}
			if form.Get("client_id") != cliClientID {
				writeJSON(w, 400, oauthFailure{"invalid_client", "client_id must be sprout-cli"})
				return
			}
			result := oauthResult{}
			switch r.URL.Path {
			case "/oauth/device_authorization":
				result, err = store.createDeviceAuthorization(r, form)
			case "/oauth/token":
				result, err = store.exchangeOAuthToken(r, form)
			case "/oauth/revoke":
				result, err = store.revokeOAuthToken(r, form)
			}
			if err != nil {
				writeJSON(w, 500, oauthFailure{"server_error", "credential storage or generation failed"})
				return
			}
			if result.body == nil {
				w.WriteHeader(result.status)
				return
			}
			writeJSON(w, result.status, result.body)
		})
	}
}

func (store *noteStore) createDeviceAuthorization(r *http.Request, form url.Values) (oauthResult, error) {
	if store.publicOrigin == "" {
		return oauthError(503, "temporarily_unavailable", "SPROUT_PUBLIC_ORIGIN is not configured"), nil
	}
	scope := strings.Fields(form.Get("scope"))
	if len(scope) != 0 && !(len(scope) == 2 && ((scope[0] == "notes:read" && scope[1] == "subscriptions:manage") || (scope[1] == "notes:read" && scope[0] == "subscriptions:manage"))) {
		return oauthError(400, "invalid_scope", "only notes:read subscriptions:manage is supported"), nil
	}
	return store.oauthTransaction(r, func(tx *sql.Tx) (oauthResult, error) {
		now := store.now().Unix()
		var count int
		if err := tx.QueryRowContext(r.Context(), `SELECT count(*) FROM oauth_device_requests WHERE status IN ('pending','approved') AND expires_at>?`, now).Scan(&count); err != nil {
			return oauthResult{}, err
		}
		if count >= 100 {
			return oauthError(429, "temporarily_unavailable", "too many outstanding device requests"), nil
		}
		device, err := randomOAuthSecret()
		if err != nil {
			return oauthResult{}, err
		}
		for attempt := 0; attempt < 5; attempt++ {
			code, err := randomUserCode()
			if err != nil {
				return oauthResult{}, err
			}
			var exists int
			if err := tx.QueryRowContext(r.Context(), `SELECT count(*) FROM oauth_device_requests WHERE user_code=?`, code).Scan(&exists); err != nil {
				return oauthResult{}, err
			}
			if exists != 0 {
				continue
			}
			if _, err := tx.ExecContext(r.Context(), `INSERT INTO oauth_device_requests(user_code,client_id,scope,expires_at) VALUES(?,?,?,?)`, code, cliClientID, cliScope, now+120); err != nil {
				return oauthResult{}, err
			}
			if _, err := tx.ExecContext(r.Context(), `INSERT INTO oauth_device_secrets VALUES(?,?,5,?)`, code, tokenHash(device), now+5); err != nil {
				return oauthResult{}, err
			}
			uri := store.publicOrigin + "/oauth/device"
			return oauthResult{200, map[string]any{"device_code": device, "user_code": code, "verification_uri": uri, "verification_uri_complete": uri + "?user_code=" + code, "expires_in": 120, "interval": 5}}, nil
		}
		return oauthResult{}, errors.New("failed to allocate unique user code")
	})
}

func (store *noteStore) exchangeOAuthToken(r *http.Request, form url.Values) (oauthResult, error) {
	grant := form.Get("grant_type")
	if grant != deviceGrantType && grant != "refresh_token" {
		return oauthError(400, "unsupported_grant_type", "unsupported grant_type"), nil
	}
	if grant == deviceGrantType && (form.Get("device_code") == "" || form.Has("refresh_token")) || grant == "refresh_token" && (form.Get("refresh_token") == "" || form.Has("device_code")) {
		return oauthError(400, "invalid_request", "grant requires exactly its credential field"), nil
	}
	return store.oauthTransaction(r, func(tx *sql.Tx) (oauthResult, error) {
		now := store.now().Unix()
		if grant == "refresh_token" {
			return store.rotateOAuthTokens(r, tx, form.Get("refresh_token"), now)
		}
		var code, status, client, scope string
		var expiry, interval, next int64
		err := tx.QueryRowContext(r.Context(), `SELECT a.user_code,a.status,a.client_id,a.scope,a.expires_at,s.poll_interval,s.next_poll_at FROM oauth_device_requests a JOIN oauth_device_secrets s ON a.user_code=s.user_code WHERE s.device_hash=?`, tokenHash(form.Get("device_code"))).Scan(&code, &status, &client, &scope, &expiry, &interval, &next)
		if errors.Is(err, sql.ErrNoRows) {
			return oauthError(400, "invalid_grant", "device credential is invalid or consumed"), nil
		}
		if err != nil {
			return oauthResult{}, err
		}
		if client != cliClientID || status == "consumed" {
			return oauthError(400, "invalid_grant", "device credential is invalid or consumed"), nil
		}
		if status == "denied" {
			return oauthError(400, "access_denied", "user denied the request"), nil
		}
		if now >= expiry {
			return oauthError(400, "expired_token", "device request expired"), nil
		}
		if scope != cliScope || interval < 5 {
			return oauthResult{}, errors.New("invalid stored device request")
		}
		if now < next {
			if _, err := tx.ExecContext(r.Context(), `UPDATE oauth_device_secrets SET poll_interval=poll_interval+5,next_poll_at=? WHERE user_code=?`, now+interval+5, code); err != nil {
				return oauthResult{}, err
			}
			return oauthError(400, "slow_down", "increase polling interval by 5 seconds"), nil
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE oauth_device_secrets SET next_poll_at=? WHERE user_code=?`, now+interval, code); err != nil {
			return oauthResult{}, err
		}
		if status == "pending" {
			return oauthError(400, "authorization_pending", "user approval is pending"), nil
		}
		if status != "approved" {
			return oauthResult{}, errors.New("invalid stored device status")
		}
		id, err := randomOAuthSecret()
		if err != nil {
			return oauthResult{}, err
		}
		deadline := now + 30*24*60*60
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO oauth_grants(grant_id,client_id,scope,expires_at) VALUES(?,?,?,?)`, id, client, scope, deadline); err != nil {
			return oauthResult{}, err
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE oauth_device_requests SET status='consumed' WHERE user_code=?`, code); err != nil {
			return oauthResult{}, err
		}
		return issueOAuthTokens(r, tx, id, scope, now, deadline)
	})
}

func issueOAuthTokens(r *http.Request, tx *sql.Tx, id, scope string, now, deadline int64) (oauthResult, error) {
	access, err := randomOAuthSecret()
	if err != nil {
		return oauthResult{}, err
	}
	refresh, err := randomOAuthSecret()
	if err != nil {
		return oauthResult{}, err
	}
	accessExpiry := min(now+900, deadline)
	for _, token := range []struct {
		secret, kind string
		expiry       int64
	}{{access, "access_token", accessExpiry}, {refresh, "refresh_token", deadline}} {
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO oauth_tokens(token_hash,grant_id,kind,expires_at) VALUES(?,?,?,?)`, tokenHash(token.secret), id, token.kind, token.expiry); err != nil {
			return oauthResult{}, err
		}
	}
	return oauthResult{200, map[string]any{"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": accessExpiry - now, "scope": scope}}, nil
}

func (store *noteStore) rotateOAuthTokens(r *http.Request, tx *sql.Tx, secret string, now int64) (oauthResult, error) {
	var id, scope, client string
	var expiry, deadline int64
	var active, revoked int
	err := tx.QueryRowContext(r.Context(), `SELECT t.grant_id,t.expires_at,t.active,g.scope,g.client_id,g.expires_at,g.revoked FROM oauth_tokens t JOIN oauth_grants g ON t.grant_id=g.grant_id WHERE t.token_hash=? AND t.kind='refresh_token'`, tokenHash(secret)).Scan(&id, &expiry, &active, &scope, &client, &deadline, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return oauthError(400, "invalid_grant", "refresh credential is invalid"), nil
	}
	if err != nil {
		return oauthResult{}, err
	}
	if client != cliClientID || revoked != 0 || now >= expiry || now >= deadline {
		return oauthError(400, "invalid_grant", "refresh credential is expired or revoked"), nil
	}
	if active == 0 {
		if _, err := tx.ExecContext(r.Context(), `UPDATE oauth_grants SET revoked=1 WHERE grant_id=?`, id); err != nil {
			return oauthResult{}, err
		}
		return oauthError(400, "invalid_grant", "refresh credential reuse revoked the authorization; login again"), nil
	}
	if scope != cliScope {
		return oauthResult{}, errors.New("invalid stored grant scope")
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE oauth_tokens SET active=0 WHERE grant_id=?`, id); err != nil {
		return oauthResult{}, err
	}
	return issueOAuthTokens(r, tx, id, scope, now, deadline)
}

func (store *noteStore) revokeOAuthToken(r *http.Request, form url.Values) (oauthResult, error) {
	if form.Get("token") == "" {
		return oauthError(400, "invalid_request", "token is required"), nil
	}
	hint := form.Get("token_type_hint")
	if hint != "" && hint != "access_token" && hint != "refresh_token" {
		return oauthError(400, "unsupported_token_type", "unsupported token_type_hint"), nil
	}
	return store.oauthTransaction(r, func(tx *sql.Tx) (oauthResult, error) {
		_, err := tx.ExecContext(r.Context(), `UPDATE oauth_grants SET revoked=1 WHERE client_id=? AND grant_id IN (SELECT grant_id FROM oauth_tokens WHERE token_hash=?)`, cliClientID, tokenHash(form.Get("token")))
		return oauthResult{200, nil}, err
	})
}
