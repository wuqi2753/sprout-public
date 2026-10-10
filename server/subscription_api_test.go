package main

// REQ-079..086: HTTP contracts, SQLite durability and live-state recovery.
import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func seedBusinessToken(t *testing.T, s *noteStore, scope string) string {
	t.Helper()
	secret, err := randomOAuthSecret()
	if err != nil {
		t.Fatal(err)
	}
	grant := "grant-" + secret
	if _, err = s.database.Exec(`INSERT INTO oauth_grants VALUES(?,?,?,?,0)`, grant, cliClientID, scope, s.now().Unix()+10000); err != nil {
		t.Fatal(err)
	}
	if _, err = s.database.Exec(`INSERT INTO oauth_tokens VALUES(?,?, 'access_token',?,1)`, tokenHash(secret), grant, s.now().Unix()+900); err != nil {
		t.Fatal(err)
	}
	return secret
}
func businessCall(h http.Handler, token, method, path, body, key string) *httptest.ResponseRecorder {
	if method == http.MethodPost && path == "/api/v1/subscriptions" && key != "" {
		if end := strings.LastIndex(body, "}"); end >= 0 {
			body = body[:end] + fmt.Sprintf(",\"creation_key\":%q", key) + body[end:]
		}
	}
	if strings.HasSuffix(path, "/backfill") && key != "" {
		if end := strings.LastIndex(body, "}"); end >= 0 {
			body = body[:end] + fmt.Sprintf(",\"request_id\":%q", key) + body[end:]
		}
	}
	if method == http.MethodPatch {
		if end := strings.LastIndex(body, "}"); end >= 0 {
			body = body[:end] + fmt.Sprintf(",\"request_id\":%q", tokenHash(body)) + body[end:]
		}
	}
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func readBusinessJSON[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if w.Code != status {
		t.Fatalf("expected %d received %d: %s", status, w.Code, w.Body.String())
	}
	var result T
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func createTestSubscription(t *testing.T, h http.Handler, token, tags, key string) subscriptionView {
	t.Helper()
	return readBusinessJSON[subscriptionView](t, businessCall(h, token, "POST", "/api/v1/subscriptions", `{"tags":`+tags+`}`, key), 201)
}
func pullTestSubscription(t *testing.T, h http.Handler, token, id string) syncPage {
	t.Helper()
	return readBusinessJSON[syncPage](t, businessCall(h, token, "POST", "/api/v1/subscriptions/"+id+"/pull", `{}`, ""), 200)
}
func ackTestSubscription(t *testing.T, h http.Handler, token, id, receipt string) subscriptionView {
	t.Helper()
	return readBusinessJSON[subscriptionView](t, businessCall(h, token, "POST", "/api/v1/subscriptions/"+id+"/ack", fmt.Sprintf(`{"receipt":%q}`, receipt), ""), 200)
}
func seedSyncNote(t *testing.T, s *noteStore, id, content string) {
	t.Helper()
	tx, err := s.database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stamp := s.now().UTC().Format(time.RFC3339Nano)
	if _, err = tx.Exec(`INSERT INTO notes(note_id,content,version,created_at,updated_at) VALUES(?,?,1,?,?)`, id, content, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err = appendNoteChange(context.Background(), tx, id, noteChangeState{tags: []string{}}, noteChangeState{version: 1, tags: extractSyncTags(content)}, stamp); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
func changeSyncNote(t *testing.T, s *noteStore, id, content string, deleted bool, physical bool) {
	t.Helper()
	tx, err := s.database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ctx := context.Background()
	before, err := readNoteChangeState(ctx, tx, id)
	if err != nil {
		t.Fatal(err)
	}
	stamp := s.now().UTC().Format(time.RFC3339Nano)
	var tombstone any
	if deleted {
		tombstone = stamp
	}
	if physical {
		err = appendPhysicalDeletion(ctx, tx, id, stamp)
		if err == nil {
			_, err = tx.Exec(`DELETE FROM notes WHERE note_id=?`, id)
		}
	} else {
		_, err = tx.Exec(`UPDATE notes SET content=?,version=version+1,deleted_at=?,updated_at=? WHERE note_id=?`, content, tombstone, stamp, id)
		if err == nil {
			after, e := readNoteChangeState(ctx, tx, id)
			err = e
			if err == nil {
				err = appendNoteChange(ctx, tx, id, before, after, stamp)
			}
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
func TestBusinessAuthorizationBoundaries(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	for _, bad := range []string{"", "forged", "test-key"} {
		w := businessCall(h, bad, "GET", "/api/v1/tags", "", "")
		if w.Code != 401 || w.Header().Get("WWW-Authenticate") == "" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	limited := seedBusinessToken(t, s, "subscriptions:manage")
	if w := businessCall(h, limited, "GET", "/api/v1/tags", "", ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if _, err := s.database.Exec(`UPDATE oauth_tokens SET kind='refresh_token' WHERE token_hash=?`, tokenHash(token)); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "GET", "/api/v1/tags", "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	for _, statement := range []string{`UPDATE oauth_tokens SET kind='access_token',active=0 WHERE token_hash=?`, `UPDATE oauth_tokens SET active=1,expires_at=0 WHERE token_hash=?`, `UPDATE oauth_tokens SET expires_at=9999999999 WHERE token_hash=?`} {
		if _, err := s.database.Exec(statement, tokenHash(token)); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(statement, "9999999999") {
			if _, err := s.database.Exec(`UPDATE oauth_grants SET revoked=1 WHERE grant_id=(SELECT grant_id FROM oauth_tokens WHERE token_hash=?)`, tokenHash(token)); err != nil {
				t.Fatal(err)
			}
		}
		if w := businessCall(h, token, "GET", "/api/v1/tags", "", ""); w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	valid := seedBusinessToken(t, s, cliScope)
	r := httptest.NewRequest("GET", "/api/v1/tags", nil)
	r.Header.Add("Authorization", "Bearer "+valid)
	r.Header.Add("Authorization", "Bearer test-key")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if err := s.database.Close(); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, valid, "GET", "/api/v1/tags", "", ""); w.Code != 500 {
		t.Fatal(w.Code)
	}
}
func TestTagsAndSubscriptionCreation(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	seedSyncNote(t, s, "tags", "#中文 #a/b #A #a #中文")
	seedSyncNote(t, s, "trash", "#trash")
	changeSyncNote(t, s, "trash", "#trash", true, false)
	discovered := readBusinessJSON[map[string][]string](t, businessCall(h, token, "GET", "/api/v1/tags", "", ""), 200)
	if fmt.Sprint(discovered["tags"]) != "[A a a/b 中文]" {
		t.Fatal(discovered)
	}
	changeSyncNote(t, s, "trash", "#trash", false, false)
	discovered = readBusinessJSON[map[string][]string](t, businessCall(h, token, "GET", "/api/v1/tags", "", ""), 200)
	if !strings.Contains(fmt.Sprint(discovered), "trash") {
		t.Fatal(discovered)
	}
	var group sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 8)
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			results <- businessCall(h, token, "POST", "/api/v1/subscriptions", `{"tags":["a","中文","a"]}`, "creation")
		}()
	}
	group.Wait()
	close(results)
	id := ""
	for w := range results {
		if w.Code != 201 && w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		sub := readBusinessJSON[subscriptionView](t, w, w.Code)
		if id != "" && id != sub.ID {
			t.Fatal("duplicate subscription")
		}
		id = sub.ID
	}
	if w := businessCall(h, token, "POST", "/api/v1/subscriptions", `{"tags":["other"]}`, "creation"); w.Code != 409 {
		t.Fatal(w.Code)
	}
	independent := createTestSubscription(t, h, token, `["a","中文"]`, "independent")
	if independent.ID == id {
		t.Fatal("same independent ID")
	}
	if w := businessCall(h, token, "GET", "/api/v1/subscriptions/"+id, "", ""); strings.Contains(w.Body.String(), "receipt") {
		t.Fatal("receipt exposed")
	}
	if _, err := s.database.Exec(`UPDATE workspace_subscriptions SET owner_id='other' WHERE subscription_id=?`, id); err == nil {
		t.Fatal("identity mutable")
	}
	foreign, err := s.createWorkspaceSubscription(context.Background(), "other", []string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "GET", "/api/v1/subscriptions/"+foreign.ID, "", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	for _, body := range []string{`{"tags":[]}`, `{"tags":["#bad"]}`, `{"tags":["a b"]}`, `{"tags":["a"],"owner_id":"other"}`} {
		if w := businessCall(h, token, "POST", "/api/v1/subscriptions", body, "bad"); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
func TestInitialSyncRecoveryAndIncrementalCutoff(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sync.db")
	s, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.close() }()
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	for i := 0; i < 61; i++ {
		seedSyncNote(t, s, fmt.Sprintf("n%03d", i), "#a #b")
	}
	sub := createTestSubscription(t, h, token, `["a","b"]`, "initial")
	first := pullTestSubscription(t, h, token, sub.ID)
	if len(first.Items) != 50 || first.Done {
		t.Fatal(len(first.Items), !first.Done)
	}
	repeat := pullTestSubscription(t, h, token, sub.ID)
	if repeat.Receipt != first.Receipt {
		t.Fatal("unstable receipt")
	}
	changeSyncNote(t, s, "n000", "#a revised", false, false)
	changeSyncNote(t, s, "n001", "#else", false, false)
	changeSyncNote(t, s, "n002", "#a", true, false)
	changeSyncNote(t, s, "n003", "#a", false, true)
	seedSyncNote(t, s, "a-new", "#a")
	repeat = pullTestSubscription(t, h, token, sub.ID)
	if repeat.Receipt == first.Receipt || repeat.Items[0].Note.Content != "#a revised" || repeat.Items[1].Action != "stop" || repeat.Items[2].Action != "stop" || repeat.Items[3].Action != "stop" {
		t.Fatal(repeat)
	}
	if w := businessCall(h, token, "POST", "/api/v1/subscriptions/"+sub.ID+"/ack", fmt.Sprintf(`{"receipt":%q}`, first.Receipt), ""); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if err = s.close(); err != nil {
		t.Fatal(err)
	}
	s, err = openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	h = newHandler("test-key", s)
	recovered := pullTestSubscription(t, h, token, sub.ID)
	if recovered.Receipt != repeat.Receipt {
		t.Fatal("lost pending")
	}
	ackTestSubscription(t, h, token, sub.ID, recovered.Receipt)
	last := pullTestSubscription(t, h, token, sub.ID)
	if len(last.Items) != 11 || !last.Done {
		t.Fatal(last)
	}
	state := ackTestSubscription(t, h, token, sub.ID, last.Receipt)
	if state.Phase != "incremental" {
		t.Fatal(state)
	}
	incremental := pullTestSubscription(t, h, token, sub.ID)
	if len(incremental.Items) != 5 {
		t.Fatal(incremental)
	}
	seedSyncNote(t, s, "z-after-cutoff", "#a")
	state = ackTestSubscription(t, h, token, sub.ID, incremental.Receipt)
	before := state.Cursor
	state = ackTestSubscription(t, h, token, sub.ID, incremental.Receipt)
	if before != state.Cursor {
		t.Fatal("replay advanced")
	}
	next := pullTestSubscription(t, h, token, sub.ID)
	if len(next.Items) != 1 || next.Items[0].NoteID != "z-after-cutoff" {
		t.Fatal(next)
	}
}
func TestIncrementalScanLimitsAndCurrentVersion(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	sub := createTestSubscription(t, h, token, `["a","b"]`, "scan")
	initial := pullTestSubscription(t, h, token, sub.ID)
	ackTestSubscription(t, h, token, sub.ID, initial.Receipt)
	for i := 0; i < 500; i++ {
		seedSyncNote(t, s, fmt.Sprintf("u%03d", i), "#unmatched")
	}
	for i := 0; i < 56; i++ {
		seedSyncNote(t, s, fmt.Sprintf("m%03d", i), "#a #b")
	}
	empty := pullTestSubscription(t, h, token, sub.ID)
	if len(empty.Items) != 0 || empty.Done {
		t.Fatal(empty)
	}
	ackTestSubscription(t, h, token, sub.ID, empty.Receipt)
	page := pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 50 || page.Done {
		t.Fatal(page)
	}
	changeSyncNote(t, s, "m000", "#b newest", false, false)
	fresh := pullTestSubscription(t, h, token, sub.ID)
	if fresh.Items[0].Note.Version != 2 {
		t.Fatal(fresh)
	}
	ackTestSubscription(t, h, token, sub.ID, fresh.Receipt)
	tail := pullTestSubscription(t, h, token, sub.ID)
	if len(tail.Items) != 6 || !tail.Done {
		t.Fatal(tail)
	}
	ackTestSubscription(t, h, token, sub.ID, tail.Receipt)
	latest := pullTestSubscription(t, h, token, sub.ID)
	if len(latest.Items) != 1 || latest.Items[0].NoteID != "m000" {
		t.Fatal(latest)
	}
}
func TestSubscriptionTagUpdateAndBackfill(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	seedSyncNote(t, s, "old", "#a")
	for i := 0; i < 56; i++ {
		seedSyncNote(t, s, fmt.Sprintf("b%03d", i), "#b #c")
	}
	sub := createTestSubscription(t, h, token, `["a"]`, "tags")
	p := pullTestSubscription(t, h, token, sub.ID)
	patch := func(body string) *httptest.ResponseRecorder {
		return businessCall(h, token, "PATCH", "/api/v1/subscriptions/"+sub.ID, body, "")
	}
	if w := patch(`{"tags":["a","b","c"],"expected_tags":["a"]}`); w.Code != 409 {
		t.Fatal(w.Code)
	}
	previous := ackTestSubscription(t, h, token, sub.ID, p.Receipt)
	changed := readBusinessJSON[subscriptionView](t, patch(`{"tags":["a","b","c"],"expected_tags":["a"]}`), 200)
	if changed.Cursor != previous.Cursor || len(changed.Eligible) != 2 {
		t.Fatal(changed)
	}
	readBusinessJSON[subscriptionView](t, patch(`{"tags":["a","b","c"],"expected_tags":["a"]}`), 200)
	backfill := func(tags, key string) *httptest.ResponseRecorder {
		return businessCall(h, token, "POST", "/api/v1/subscriptions/"+sub.ID+"/backfill", `{"tags":`+tags+`}`, key)
	}
	if w := backfill(`["a"]`, "bad"); w.Code != 400 {
		t.Fatal(w.Code)
	}
	readBusinessJSON[subscriptionView](t, backfill(`["b","c"]`, "fill"), 200)
	readBusinessJSON[subscriptionView](t, backfill(`["c","b"]`, "fill"), 200)
	if w := backfill(`["b"]`, "fill"); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w := patch(`{"tags":["b"],"expected_tags":["a","b","c"]}`); w.Code != 409 {
		t.Fatal(w.Code)
	}
	first := pullTestSubscription(t, h, token, sub.ID)
	if first.Phase != "backfill" || len(first.Items) != 50 || first.Done {
		t.Fatal(first)
	}
	state := ackTestSubscription(t, h, token, sub.ID, first.Receipt)
	if state.Cursor != previous.Cursor {
		t.Fatal(state)
	}
	var cursor struct {
		Change int64 `json:"change_id"`
	}
	json.Unmarshal([]byte(previous.Cursor), &cursor)
	var during struct {
		Change int64 `json:"change_id"`
	}
	json.Unmarshal([]byte(state.Cursor), &during)
	if cursor.Change != during.Change {
		t.Fatal("backfill moved increment")
	}
	changeSyncNote(t, s, "b000", "#b revised", false, false)
	seedSyncNote(t, s, "new-backfill", "#b")
	tail := pullTestSubscription(t, h, token, sub.ID)
	if len(tail.Items) != 6 {
		t.Fatal(tail)
	}
	finished := ackTestSubscription(t, h, token, sub.ID, tail.Receipt)
	if finished.Cursor != previous.Cursor || len(finished.Eligible) != 0 {
		t.Fatal(finished)
	}
	readBusinessJSON[subscriptionView](t, backfill(`["b","c"]`, "fill"), 200)
	delta := pullTestSubscription(t, h, token, sub.ID)
	if len(delta.Items) != 2 {
		t.Fatal(delta)
	}
	ackTestSubscription(t, h, token, sub.ID, delta.Receipt)
	if w := patch(`{"tags":["c"],"expected_tags":["wrong"]}`); w.Code != 409 {
		t.Fatal(w.Code)
	}
}
func TestSyncConcurrentPullAckAndRollback(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	seedSyncNote(t, s, "one", "#a")
	sub := createTestSubscription(t, h, token, `["a"]`, "concurrency")
	path := "/api/v1/subscriptions/" + sub.ID
	var group sync.WaitGroup
	outputs := make(chan *httptest.ResponseRecorder, 10)
	for range 10 {
		group.Add(1)
		go func() { defer group.Done(); outputs <- businessCall(h, token, "POST", path+"/pull", `{}`, "") }()
	}
	group.Wait()
	close(outputs)
	receipt := ""
	for w := range outputs {
		p := readBusinessJSON[syncPage](t, w, 200)
		if receipt != "" && receipt != p.Receipt {
			t.Fatal("pending overwritten")
		}
		receipt = p.Receipt
	}
	if _, err := s.database.Exec(`CREATE TRIGGER reject_sync_state BEFORE UPDATE ON subscription_api_state BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "POST", path+"/ack", fmt.Sprintf(`{"receipt":%q}`, receipt), ""); w.Code != 500 {
		t.Fatal(w.Code)
	}
	var pending string
	if err := s.database.QueryRow(`SELECT pending_receipt FROM workspace_subscriptions WHERE subscription_id=?`, sub.ID).Scan(&pending); err != nil || pending != receipt {
		t.Fatal("transaction partially advanced", err)
	}
	if _, err := s.database.Exec(`DROP TRIGGER reject_sync_state`); err != nil {
		t.Fatal(err)
	}
	outputs = make(chan *httptest.ResponseRecorder, 10)
	for range 10 {
		group.Add(1)
		go func() {
			defer group.Done()
			outputs <- businessCall(h, token, "POST", path+"/ack", fmt.Sprintf(`{"receipt":%q}`, receipt), "")
		}()
	}
	group.Wait()
	close(outputs)
	for w := range outputs {
		readBusinessJSON[subscriptionView](t, w, 200)
	}
}
func TestOAuthAttachmentReadActiveReferences(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	imageID := testNoteID + ":0"
	fileID := testNoteID + ":file"
	png := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1}
	pdf := []byte("%PDF-1.7\noriginal")
	request := httptest.NewRequest("PUT", objectsPath+imageID, bytes.NewReader(png))
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set("Content-Type", "image/png")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, request)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := uploadTestFile(h, fileID, "test.pdf", "application/pdf", pdf); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	created := performRequest(h, "POST", notesPath, fmt.Sprintf(`{"note_id":%q,"content":"#a","images":[%q],"files":[%q],"created_at":"2026-10-02T08:30:00Z"}`, testNoteID, imageID, fileID), testCreateOpID)
	if created.Code != 201 {
		t.Fatal(created.Code, created.Body.String())
	}
	sub := createTestSubscription(t, h, token, `["a"]`, "attachment")
	page := pullTestSubscription(t, h, token, sub.ID)
	var before string
	s.database.QueryRow(`SELECT state FROM subscription_api_state WHERE subscription_id=?`, sub.ID).Scan(&before)
	for _, entry := range []struct {
		path string
		body []byte
	}{{objectsPath + imageID, png}, {filesPath + fileID, pdf}} {
		w := businessCall(h, token, "GET", entry.path, "", "")
		if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), entry.body) {
			t.Fatal(w.Code, w.Body.String())
		}
		if w := businessCall(h, token, "PUT", entry.path, "", ""); w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	var after string
	s.database.QueryRow(`SELECT state FROM subscription_api_state WHERE subscription_id=?`, sub.ID).Scan(&after)
	if before != after {
		t.Fatal("download changed sync")
	}
	deleted := performRequest(h, "DELETE", notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
	if deleted.Code != 200 {
		t.Fatal(deleted.Code, deleted.Body.String())
	}
	for _, path := range []string{objectsPath + imageID, filesPath + fileID} {
		if w := businessCall(h, token, "GET", path, "", ""); w.Code != 404 {
			t.Fatal(w.Code)
		}
		if w := performRequest(h, "GET", path, "", ""); w.Code != 200 {
			t.Fatal("API key regression", w.Code)
		}
	}
	reread := pullTestSubscription(t, h, token, sub.ID)
	if reread.Items[0].Action != "stop" || reread.Receipt == page.Receipt {
		t.Fatal(reread)
	}
	restored := performRequest(h, "POST", notesPath+"/"+testNoteID+"/restore", `{"base_version":2}`, "0199a633-67aa-7e58-97f8-0196e3684ba1")
	if restored.Code != 200 {
		t.Fatal(restored.Code, restored.Body.String())
	}
	if w := businessCall(h, token, "GET", filesPath+fileID, "", ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := businessCall(h, token, "POST", notesPath, `{}`, ""); w.Code != 401 {
		t.Fatal("OAuth write opened", w.Code)
	}
}

func TestBusinessRefreshAndReauthorizationKeepOwner(t *testing.T) {
	s := openTestStore(t)
	s.publicOrigin = "https://notes.example.com"
	now := int64(1000)
	s.now = func() time.Time { return time.Unix(now, 0) }
	h := newHandler("test-key", s)
	login := func() map[string]any {
		a := createOAuthApplication(t, h)
		approveOAuthApplication(t, h, a)
		now += 5
		return oauthJSON(t, oauthCall(h, "/oauth/token", deviceTokenFields(a)), 200)
	}
	first := login()
	access := first["access_token"].(string)
	sub := createTestSubscription(t, h, access, `["a"]`, "stable")
	page := pullTestSubscription(t, h, access, sub.ID)
	rotated := oauthJSON(t, oauthCall(h, "/oauth/token", oauthFields("grant_type", "refresh_token", "refresh_token", first["refresh_token"].(string))), 200)
	if w := businessCall(h, access, "GET", "/api/v1/subscriptions/"+sub.ID, "", ""); w.Code != 401 {
		t.Fatal("old access survived refresh", w.Code)
	}
	access = rotated["access_token"].(string)
	ackTestSubscription(t, h, access, sub.ID, page.Receipt)
	second := login()
	access = second["access_token"].(string)
	state := readBusinessJSON[subscriptionView](t, businessCall(h, access, "GET", "/api/v1/subscriptions/"+sub.ID, "", ""), 200)
	if state.Phase != "incremental" {
		t.Fatal("reauthorization reset progress")
	}
	oauthJSON(t, oauthCall(h, "/oauth/revoke", oauthFields("token", access)), 200)
	if w := businessCall(h, access, "GET", "/api/v1/tags", "", ""); w.Code != 401 {
		t.Fatal("revocation ignored")
	}
}

func TestBackfillAndIncrementalRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recovery.db")
	s, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.close() }()
	token := seedBusinessToken(t, s, cliScope)
	h := newHandler("test-key", s)
	seedSyncNote(t, s, "old-b", "#b")
	sub := createTestSubscription(t, h, token, `["a"]`, "restart")
	initial := pullTestSubscription(t, h, token, sub.ID)
	before := ackTestSubscription(t, h, token, sub.ID, initial.Receipt)
	readBusinessJSON[subscriptionView](t, businessCall(h, token, "PATCH", "/api/v1/subscriptions/"+sub.ID, `{"tags":["a","b"],"expected_tags":["a"]}`, ""), 200)
	// Opting out of backfill does not read old newly subscribed material.
	noBackfill := pullTestSubscription(t, h, token, sub.ID)
	if len(noBackfill.Items) != 0 {
		t.Fatal(noBackfill)
	}
	ackTestSubscription(t, h, token, sub.ID, noBackfill.Receipt)
	readBusinessJSON[subscriptionView](t, businessCall(h, token, "POST", "/api/v1/subscriptions/"+sub.ID+"/backfill", `{"tags":["b"]}`, "recover-fill"), 200)
	pending := pullTestSubscription(t, h, token, sub.ID)
	reopen := func() {
		t.Helper()
		if err := s.close(); err != nil {
			t.Fatal(err)
		}
		s, err = openNoteStore(path)
		if err != nil {
			t.Fatal(err)
		}
		h = newHandler("test-key", s)
	}
	reopen()
	restored := pullTestSubscription(t, h, token, sub.ID)
	if restored.Receipt != pending.Receipt || restored.Items[0].NoteID != "old-b" {
		t.Fatal(restored)
	}
	after := ackTestSubscription(t, h, token, sub.ID, restored.Receipt)
	if after.Cursor != before.Cursor {
		t.Fatal("backfill advanced cursor")
	}
	changeSyncNote(t, s, "old-b", "#b newest", false, false)
	delta := pullTestSubscription(t, h, token, sub.ID)
	reopen()
	recovered := pullTestSubscription(t, h, token, sub.ID)
	if recovered.Receipt != delta.Receipt {
		t.Fatal("incremental receipt lost")
	}
	ackTestSubscription(t, h, token, sub.ID, recovered.Receipt)
	readBusinessJSON[subscriptionView](t, businessCall(h, token, "POST", "/api/v1/subscriptions/"+sub.ID+"/backfill", `{"tags":["b"]}`, "recover-fill"), 200)
}

func TestSyncBoundaryAndTransactionFailures(t *testing.T) {
	s := openTestStore(t)
	token := seedBusinessToken(t, s, cliScope)
	h := newHandler("test-key", s)
	for _, body := range []string{`null`, `[]`, `{"tags":null}`, `{"tags":["a"],"tags":["b"]}`, `{"tags":["a"]} {}`, `{"tags":["` + strings.Repeat("a", 257) + `"]}`} {
		if w := businessCall(h, token, "POST", "/api/v1/subscriptions", body, "invalid"); w.Code != 400 {
			t.Fatal(body, w.Code)
		}
	}
	if _, err := s.database.Exec(`CREATE TRIGGER reject_create BEFORE INSERT ON subscription_api_state BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "POST", "/api/v1/subscriptions", `{"tags":["a"]}`, "rollback"); w.Code != 500 {
		t.Fatal(w.Code)
	}
	var count int
	if err := s.database.QueryRow(`SELECT count(*) FROM workspace_subscriptions`).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial creation", count, err)
	}
	if _, err := s.database.Exec(`DROP TRIGGER reject_create`); err != nil {
		t.Fatal(err)
	}
	sub := createTestSubscription(t, h, token, `["a"]`, "rollback")
	p := pullTestSubscription(t, h, token, sub.ID)
	ackTestSubscription(t, h, token, sub.ID, p.Receipt)
	if _, err := s.database.Exec(`CREATE TRIGGER reject_update BEFORE UPDATE ON subscription_api_state BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "PATCH", "/api/v1/subscriptions/"+sub.ID, `{"tags":["a","b"],"expected_tags":["a"]}`, ""); w.Code != 500 {
		t.Fatal(w.Code)
	}
	var tags string
	if err := s.database.QueryRow(`SELECT tags FROM workspace_subscriptions WHERE subscription_id=?`, sub.ID).Scan(&tags); err != nil || tags != `["a"]` {
		t.Fatal("partial tag update", tags, err)
	}
	if _, err := s.database.Exec(`DROP TRIGGER reject_update`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "POST", "/api/v1/subscriptions/"+sub.ID+"/pull", `{"receipt":null}`, ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if _, err := s.database.Exec(`UPDATE subscription_api_state SET state=json_set(state,'$.cursor',999999) WHERE subscription_id=?`, sub.ID); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "POST", "/api/v1/subscriptions/"+sub.ID+"/pull", `{}`, ""); w.Code != 500 {
		t.Fatal("bad cursor silently reset", w.Code)
	}
}

func TestIncrementalGapsDeletionRestoreAndDeduplication(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	seedSyncNote(t, s, "memo", "#a #b")
	sub := createTestSubscription(t, h, token, `["a","b"]`, "lifecycle")
	page := pullTestSubscription(t, h, token, sub.ID)
	ackTestSubscription(t, h, token, sub.ID, page.Receipt)
	changeSyncNote(t, s, "memo", "#b", false, false)
	changeSyncNote(t, s, "memo", "#b latest", false, false)
	page = pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 1 || page.Items[0].Action != "upsert" || page.Items[0].Note.Version != 3 {
		t.Fatal(page)
	}
	ackTestSubscription(t, h, token, sub.ID, page.Receipt)
	changeSyncNote(t, s, "memo", "#unsubscribed", false, false)
	page = pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 1 || page.Items[0].Action != "stop" {
		t.Fatal(page)
	}
	ackTestSubscription(t, h, token, sub.ID, page.Receipt)
	changeSyncNote(t, s, "memo", "#a", false, false)
	changeSyncNote(t, s, "memo", "#a", true, false)
	page = pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 1 || page.Items[0].Action != "stop" {
		t.Fatal(page)
	}
	ackTestSubscription(t, h, token, sub.ID, page.Receipt)
	changeSyncNote(t, s, "memo", "#a", false, false)
	page = pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 1 || page.Items[0].Action != "upsert" {
		t.Fatal(page)
	}
	ackTestSubscription(t, h, token, sub.ID, page.Receipt)
	changeSyncNote(t, s, "memo", "#a", false, true)
	page = pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 1 || page.Items[0].Action != "stop" {
		t.Fatal(page)
	}
	ackTestSubscription(t, h, token, sub.ID, page.Receipt)
	// Sequence gaps are not counted as scanned rows.
	if _, err := s.database.Exec(`UPDATE sqlite_sequence SET seq=seq+10000 WHERE name='note_changes'`); err != nil {
		t.Fatal(err)
	}
	seedSyncNote(t, s, "after-gap", "#a")
	page = pullTestSubscription(t, h, token, sub.ID)
	if len(page.Items) != 1 || !page.Done {
		t.Fatal(page)
	}
}

func TestBusinessMigrationRetainsLegacyState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	s, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	token := seedBusinessToken(t, s, cliScope)
	seedSyncNote(t, s, "retained", "#a")
	sub, err := s.createWorkspaceSubscription(context.Background(), "legacy-owner", []string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	old := "old-cursor"
	receipt := "old-receipt"
	if err = s.updateWorkspaceSubscriptionProgress(context.Background(), sub.OwnerID, sub.ID, sub.Progress, subscriptionProgress{PendingCursor: &old, PendingReceipt: &receipt}); err != nil {
		t.Fatal(err)
	}
	// Emulate the previous REQ-078 identity/tags trigger before upgrading.
	if _, err = s.database.Exec(`DROP TRIGGER workspace_subscription_identity_fixed; CREATE TRIGGER workspace_subscription_identity_fixed BEFORE UPDATE OF subscription_id,owner_id,tags ON workspace_subscriptions WHEN NEW.subscription_id IS NOT OLD.subscription_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.tags IS NOT OLD.tags BEGIN SELECT RAISE(ABORT,'fixed'); END`); err != nil {
		t.Fatal(err)
	}
	var owner string
	if err = s.database.QueryRow(`SELECT owner_id FROM server_identity`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if err = s.close(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		s, err = openNoteStore(path)
		if err != nil {
			t.Fatal(err)
		}
		restored, err := s.getWorkspaceSubscription(context.Background(), sub.OwnerID, sub.ID)
		if err != nil || restored.Progress.PendingReceipt == nil || *restored.Progress.PendingReceipt != receipt {
			t.Fatal(restored, err)
		}
		var retainedOwner string
		if err = s.database.QueryRow(`SELECT owner_id FROM server_identity`).Scan(&retainedOwner); err != nil || retainedOwner != owner {
			t.Fatal("owner changed", err)
		}
		h := newHandler("test-key", s)
		if w := businessCall(h, token, "GET", "/api/v1/tags", "", ""); w.Code != 200 {
			t.Fatal(w.Code)
		}
		if _, err = s.database.Exec(`UPDATE workspace_subscriptions SET tags='["a","b"]' WHERE subscription_id=?`, sub.ID); err != nil {
			t.Fatal("migration kept old tags trigger", err)
		}
		if err = s.close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOAuthAttachmentSharedAndOrphanReferences(t *testing.T) {
	s := openTestStore(t)
	h := newHandler("test-key", s)
	token := seedBusinessToken(t, s, cliScope)
	id := testNoteID + ":0"
	png := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 9}
	r := httptest.NewRequest("PUT", objectsPath+id, bytes.NewReader(png))
	r.Header.Set("Authorization", "Bearer test-key")
	r.Header.Set("Content-Type", "image/png")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 201 {
		t.Fatal(w.Code)
	}
	if w := businessCall(h, token, "GET", objectsPath+id, "", ""); w.Code != 404 {
		t.Fatal("orphan readable", w.Code)
	}
	seedSyncNote(t, s, "reference1", "#a")
	seedSyncNote(t, s, "reference2", "#a")
	if _, err := s.database.Exec(`INSERT INTO note_images VALUES('reference1',0,?),('reference2',0,?)`, id, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.database.Exec(`UPDATE notes SET deleted_at='2026-10-09T00:00:00Z' WHERE note_id='reference1'`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "GET", objectsPath+id, "", ""); w.Code != 200 {
		t.Fatal("active shared reference rejected", w.Code)
	}
	if _, err := s.database.Exec(`DELETE FROM note_images WHERE note_id='reference2'; DELETE FROM notes WHERE note_id='reference2'`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "GET", objectsPath+id, "", ""); w.Code != 404 {
		t.Fatal("only trash reference readable", w.Code)
	}
	if _, err := s.database.Exec(`DELETE FROM note_images WHERE note_id='reference1'; DELETE FROM notes WHERE note_id='reference1'`); err != nil {
		t.Fatal(err)
	}
	if w := businessCall(h, token, "GET", objectsPath+id, "", ""); w.Code != 404 {
		t.Fatal("purged reference readable", w.Code)
	}
}
