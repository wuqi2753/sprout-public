package main

// REQ-076: credential lifecycle via real handlers and persistent SQLite.
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func oauthCall(handler http.Handler, path string, fields url.Values) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(fields.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func oauthFields(pairs ...string) url.Values {
	fields := url.Values{"client_id": {cliClientID}}
	for i := 0; i < len(pairs); i += 2 {
		fields.Set(pairs[i], pairs[i+1])
	}
	return fields
}
func oauthJSON(t *testing.T, response *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	if response.Code != status {
		t.Fatalf("%d expected %d: %s", response.Code, status, response.Body.String())
	}
	fields := map[string]any{}
	if response.Body.Len() > 0 {
		if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
			t.Fatal(err)
		}
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing no-store")
	}
	return fields
}
func expectOAuthError(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if fields := oauthJSON(t, w, status); fields["error"] != code {
		t.Fatal(fields)
	}
}
func createOAuthApplication(t *testing.T, h http.Handler) map[string]any {
	t.Helper()
	return oauthJSON(t, oauthCall(h, "/oauth/device_authorization", oauthFields()), 200)
}
func approveOAuthApplication(t *testing.T, h http.Handler, a map[string]any) {
	t.Helper()
	w := requestDeviceApproval(h, "POST", a["user_code"].(string)+"/decision", `{"decision":"approve"}`, "test-key")
	if w.Code != 200 {
		t.Fatalf("approval %d %s", w.Code, w.Body.String())
	}
}
func deviceTokenFields(a map[string]any) url.Values {
	return oauthFields("grant_type", deviceGrantType, "device_code", a["device_code"].(string))
}

func TestOAuthLifecycle(t *testing.T) {
	store := openTestStore(t)
	store.publicOrigin = "https://notes.example.com"
	now := int64(1000)
	store.now = func() time.Time { return time.Unix(now, 0) }
	h := newHandler("test-key", store)
	a := createOAuthApplication(t, h)
	if a["expires_in"] != float64(120) || a["interval"] != float64(5) || a["verification_uri"] != "https://notes.example.com/oauth/device" || !userCodePattern.MatchString(a["user_code"].(string)) {
		t.Fatal(a)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 400, "slow_down")
	now += 10
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 400, "authorization_pending")
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 400, "slow_down")
	approveOAuthApplication(t, h, a)
	now += 15
	tokens := oauthJSON(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 200)
	if tokens["scope"] != cliScope || tokens["expires_in"] != float64(900) || tokens["token_type"] != "Bearer" {
		t.Fatal(tokens)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 400, "invalid_grant")
	access := tokens["access_token"].(string)
	refresh := tokens["refresh_token"].(string)
	if valid, err := store.validateOAuthAccess(access); err != nil || !valid {
		t.Fatalf("access: %v %v", valid, err)
	}
	var secretHash string
	if err := store.database.QueryRow(`SELECT device_hash FROM oauth_device_secrets`).Scan(&secretHash); err != nil || secretHash != tokenHash(a["device_code"].(string)) {
		t.Fatal(secretHash, err)
	}
	var count int
	if err := store.database.QueryRow(`SELECT count(*) FROM oauth_tokens WHERE token_hash IN (?,?)`, access, refresh).Scan(&count); err != nil || count != 0 {
		t.Fatal("plaintext stored", err)
	}
	rotated := oauthJSON(t, oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", refresh)), 200)
	if rotated["refresh_token"] == refresh || rotated["access_token"] == access {
		t.Fatal("rotation failed")
	}
	if valid, err := store.validateOAuthAccess(access); err != nil || valid {
		t.Fatal("old access active", err)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", refresh)), 400, "invalid_grant")
	if valid, err := store.validateOAuthAccess(rotated["access_token"].(string)); err != nil || valid {
		t.Fatal("replay did not revoke", err)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", rotated["refresh_token"].(string))), 400, "invalid_grant")
}

func TestOAuthDeniedExpiredAndRevoke(t *testing.T) {
	store := openTestStore(t)
	store.publicOrigin = "https://notes.example.com"
	now := int64(1000)
	store.now = func() time.Time { return time.Unix(now, 0) }
	h := newHandler("test-key", store)
	denied := createOAuthApplication(t, h)
	w := requestDeviceApproval(h, "POST", denied["user_code"].(string)+"/decision", `{"decision":"deny"}`, "test-key")
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(denied)), 400, "access_denied")
	expired := createOAuthApplication(t, h)
	now += 120
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(expired)), 400, "expired_token")
	var tokenSets []map[string]any
	for i := 0; i < 2; i++ {
		a := createOAuthApplication(t, h)
		approveOAuthApplication(t, h, a)
		now += 5
		tokenSets = append(tokenSets, oauthJSON(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 200))
	}
	first := tokenSets[0]
	for i := 0; i < 2; i++ {
		w := oauthCall(h, "/oauth/revoke", oauthFields("token", first["access_token"].(string), "token_type_hint", "refresh_token"))
		oauthJSON(t, w, 200)
		if w.Body.Len() != 0 {
			t.Fatal("revoke not empty")
		}
	}
	oauthJSON(t, oauthCall(h, "/oauth/revoke", oauthFields("token", "unknown")), 200)
	if valid, err := store.validateOAuthAccess(first["access_token"].(string)); err != nil || valid {
		t.Fatal(valid, err)
	}
	if valid, err := store.validateOAuthAccess(tokenSets[1]["access_token"].(string)); err != nil || !valid {
		t.Fatal("unrelated revoked", err)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", first["refresh_token"].(string))), 400, "invalid_grant")
	now += 900
	if valid, err := store.validateOAuthAccess(tokenSets[1]["access_token"].(string)); err != nil || valid {
		t.Fatal("access expiry", err)
	}
	now += 30 * 24 * 60 * 60
	expectOAuthError(t, oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", tokenSets[1]["refresh_token"].(string))), 400, "invalid_grant")
}

func TestOAuthInputAndCapacity(t *testing.T) {
	store := openTestStore(t)
	h := newHandler("test-key", store)
	expectOAuthError(t, oauthCall(h, "/oauth/device_authorization", oauthFields()), 503, "temporarily_unavailable")
	store.publicOrigin = "https://notes.example.com"
	cases := []struct {
		path string
		form url.Values
		code string
	}{
		{"/oauth/device_authorization", oauthFields("scope", "notes:write"), "invalid_scope"},
		{"/oauth/device_authorization", oauthFields("client_id", "evil"), "invalid_client"},
		{"/oauth/device_authorization", oauthFields("client_secret", "secret"), "invalid_request"},
		{"/oauth/token", oauthFields("grant_type", "password"), "unsupported_grant_type"},
		{"/oauth/token", oauthFields("grant_type", deviceGrantType), "invalid_request"},
		{"/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", "bad"), "invalid_grant"},
		{"/oauth/token", oauthFields("grant_type", deviceGrantType, "device_code", "bad"), "invalid_grant"},
		{"/oauth/revoke", oauthFields(), "invalid_request"},
		{"/oauth/revoke", oauthFields("token", "bad", "token_type_hint", "other"), "unsupported_token_type"},
	}
	for _, c := range cases {
		expectOAuthError(t, oauthCall(h, c.path, c.form), 400, c.code)
	}
	repeated := oauthFields()
	repeated.Add("client_id", cliClientID)
	expectOAuthError(t, oauthCall(h, "/oauth/device_authorization", repeated), 400, "invalid_request")
	oversized := oauthFields("scope", strings.Repeat("x", 4096))
	expectOAuthError(t, oauthCall(h, "/oauth/device_authorization", oversized), 400, "invalid_request")
	for _, path := range []string{"/oauth/device_authorization", "/oauth/token", "/oauth/revoke"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		expectOAuthError(t, w, 405, "invalid_request")
		r := httptest.NewRequest("POST", path, strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		expectOAuthError(t, w, 400, "invalid_request")
	}
	r := httptest.NewRequest("POST", "/oauth/device_authorization", strings.NewReader(oauthFields().Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Host = "evil.example"
	r.Header.Set("X-Forwarded-Host", "evil.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	a := oauthJSON(t, w, 200)
	if strings.Contains(a["verification_uri"].(string), "evil") {
		t.Fatal(a)
	}
	for i := 1; i < 100; i++ {
		createOAuthApplication(t, h)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/device_authorization", oauthFields()), 429, "temporarily_unavailable")
	if _, err := store.database.Exec(`UPDATE oauth_device_requests SET expires_at=1`); err != nil {
		t.Fatal(err)
	}
	createOAuthApplication(t, h)
}

func TestOAuthConcurrencyAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oauth.db")
	store, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	store.publicOrigin = "https://notes.example.com"
	store.now = func() time.Time { return time.Unix(1000, 0) }
	h := newHandler("test-key", store)
	a := createOAuthApplication(t, h)
	approveOAuthApplication(t, h, a)
	store.now = func() time.Time { return time.Unix(1005, 0) }
	results := make(chan *httptest.ResponseRecorder, 2)
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() { defer group.Done(); results <- oauthCall(h, "/oauth/token", deviceTokenFields(a)) }()
	}
	group.Wait()
	close(results)
	var tokens map[string]any
	success := 0
	for w := range results {
		if w.Code == 200 {
			success++
			tokens = oauthJSON(t, w, 200)
		} else {
			expectOAuthError(t, w, 400, "invalid_grant")
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := reopened.close(); err != nil {
			t.Error(err)
		}
	}()
	reopened.now = func() time.Time { return time.Unix(1005, 0) }
	h = newHandler("test-key", reopened)
	if valid, err := reopened.validateOAuthAccess(tokens["access_token"].(string)); err != nil || !valid {
		t.Fatal(valid, err)
	}
	results = make(chan *httptest.ResponseRecorder, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			results <- oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", tokens["refresh_token"].(string)))
		}()
	}
	group.Wait()
	close(results)
	success = 0
	var rotated map[string]any
	for w := range results {
		if w.Code == 200 {
			success++
			rotated = oauthJSON(t, w, 200)
		} else {
			expectOAuthError(t, w, 400, "invalid_grant")
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	if valid, err := reopened.validateOAuthAccess(rotated["access_token"].(string)); err != nil || valid {
		t.Fatal("concurrent reuse must revoke", err)
	}
}

func TestOAuthOriginConfiguration(t *testing.T) {
	for _, origin := range []string{"https://notes.example.com/", "http://notes.example.com", strings.Join([]string{"https:", "//secret", "@", "notes.example.com"}, ""), "https://notes.example.com/path"} {
		config, err := loadConfig(func(key string) string {
			if key == "SPROUT_API_KEY" {
				return "test-key"
			}
			if key == "SPROUT_PUBLIC_ORIGIN" {
				return origin
			}
			return ""
		})
		if origin == "https://notes.example.com/" {
			if err != nil || config.publicOrigin != "https://notes.example.com" {
				t.Fatal(config, err)
			}
		} else if err == nil {
			t.Fatal("invalid origin accepted")
		}
	}
}

// Inspect credential validity without prematurely opening business API routes.
func (store *noteStore) validateOAuthAccess(secret string) (bool, error) {
	var count int
	err := store.database.QueryRow(`SELECT count(*) FROM oauth_tokens t JOIN oauth_grants g ON t.grant_id=g.grant_id WHERE t.token_hash=? AND t.kind='access_token' AND t.active=1 AND t.expires_at>? AND g.expires_at>? AND g.revoked=0 AND g.client_id=? AND g.scope=?`, tokenHash(secret), store.now().Unix(), store.now().Unix(), cliClientID, cliScope).Scan(&count)
	return count == 1, err
}

func TestOAuthIssuanceRollback(t *testing.T) {
	store := openTestStore(t)
	store.publicOrigin = "https://notes.example.com"
	now := int64(1000)
	store.now = func() time.Time { return time.Unix(now, 0) }
	h := newHandler("test-key", store)
	a := createOAuthApplication(t, h)
	approveOAuthApplication(t, h, a)
	now += 5
	if _, err := store.database.Exec(`CREATE TRIGGER reject_token BEFORE INSERT ON oauth_tokens BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	expectOAuthError(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 500, "server_error")
	var status string
	if err := store.database.QueryRow(`SELECT status FROM oauth_device_requests WHERE user_code=?`, a["user_code"]).Scan(&status); err != nil || status != "approved" {
		t.Fatal(status, err)
	}
	var count int
	if err := store.database.QueryRow(`SELECT count(*) FROM oauth_grants`).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
	if _, err := store.database.Exec(`DROP TRIGGER reject_token`); err != nil {
		t.Fatal(err)
	}
	oauthJSON(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 200)
}
