package main

// REQ-075: App approval API boundaries, persistence and atomic decisions.
import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func seedDeviceRequest(t *testing.T, store *noteStore, status string, expires int64) {
	t.Helper()
	if _, err := store.database.Exec(`INSERT INTO oauth_device_requests(user_code,client_id,scope,expires_at,status) VALUES('ABCD-1234','sprout-cli','notes:read',?,?)`, expires, status); err != nil {
		t.Fatal(err)
	}
}
func requestDeviceApproval(handler http.Handler, method, path, body, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, deviceRequestsPath+path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+key)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
func TestDeviceApprovalBoundaries(t *testing.T) {
	store := openTestStore(t)
	store.now = func() time.Time { return time.Unix(1000, 0) }
	seedDeviceRequest(t, store, "pending", 2000)
	handler := newHandler("test-key", store)
	queried := requestDeviceApproval(handler, "GET", "ABCD-1234", "", "test-key")
	var application deviceRequest
	if err := json.Unmarshal(queried.Body.Bytes(), &application); err != nil {
		t.Fatal(err)
	}
	if application.UserCode != "ABCD-1234" || application.ClientID != "sprout-cli" || application.Scope != "notes:read" || application.Status != "pending" || application.ExpiresAt != time.Unix(2000, 0).UTC().Format(time.RFC3339) {
		t.Fatalf("unexpected application: %+v", application)
	}
	cases := []struct {
		method, path, body, key string
		status                  int
	}{
		{"GET", "ABCD-1234", "", "bad", 401},
		{"GET", "abcd-1234", "", "test-key", 400},
		{"GET", "ZZZZ-9999", "", "test-key", 404},
		{"POST", "ABCD-1234", "", "test-key", 405},
		{"GET", "ABCD-1234/decision", "", "test-key", 405},
		{"POST", "ABCD-1234/decision", `{"decision":"yes"}`, "test-key", 400},
		{"POST", "ABCD-1234/decision", `{"decision":"approve","extra":1}`, "test-key", 400},
		{"POST", "ABCD-1234/decision", `{"decision":"approve"} {}`, "test-key", 400},
		{"POST", "ABCD-1234/decision", strings.Repeat(" ", 1024) + `{"decision":"approve"}`, "test-key", 400},
		{"GET", "ABCD-1234", "", "test-key", 200},
		{"POST", "ABCD-1234/decision", `{"decision":"approve"}`, "test-key", 200},
		{"POST", "ABCD-1234/decision", `{"decision":"approve"}`, "test-key", 200},
		{"POST", "ABCD-1234/decision", `{"decision":"deny"}`, "test-key", 409},
	}
	for _, c := range cases {
		response := requestDeviceApproval(handler, c.method, c.path, c.body, c.key)
		if response.Code != c.status {
			t.Fatalf("%s %s %s: %d %s", c.method, c.path, c.body, response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing no-store")
		}
		if strings.Contains(response.Body.String(), "device_code") || strings.Contains(response.Body.String(), "test-key") {
			t.Fatal("secret disclosure")
		}
	}
	var decided int64
	if err := store.database.QueryRow(`SELECT decided_at FROM oauth_device_requests`).Scan(&decided); err != nil || decided != 1000 {
		t.Fatalf("approval timestamp: %d %v", decided, err)
	}
	store.now = func() time.Time { return time.Unix(2000, 0) }
	if response := requestDeviceApproval(handler, "GET", "ABCD-1234", "", "test-key"); !strings.Contains(response.Body.String(), `"status":"expired"`) {
		t.Fatal(response.Body.String())
	}
	if response := requestDeviceApproval(handler, "POST", "ABCD-1234/decision", `{"decision":"approve"}`, "test-key"); response.Code != 410 {
		t.Fatal(response.Code)
	}
}

func TestDeviceDecisionStates(t *testing.T) {
	for _, status := range []string{"pending", "denied", "consumed"} {
		t.Run(status, func(t *testing.T) {
			store := openTestStore(t)
			store.now = func() time.Time { return time.Unix(1000, 0) }
			seedDeviceRequest(t, store, status, 1000)
			expected := 410
			if status == "denied" {
				expected = 200
			}
			if status == "consumed" {
				expected = 409
			}
			response := requestDeviceApproval(newHandler("test-key", store), "POST", "ABCD-1234/decision", `{"decision":"deny"}`, "test-key")
			if response.Code != expected {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestDeviceDecisionConcurrentAndPersistent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "approval.db")
	store, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	store.now = func() time.Time { return time.Unix(1000, 0) }
	seedDeviceRequest(t, store, "pending", 2000)
	handler := newHandler("test-key", store)
	results := make(chan int, 2)
	var group sync.WaitGroup
	for _, decision := range []string{"approve", "deny"} {
		group.Add(1)
		go func(decision string) {
			defer group.Done()
			results <- requestDeviceApproval(handler, "POST", "ABCD-1234/decision", `{"decision":"`+decision+`"}`, "test-key").Code
		}(decision)
	}
	group.Wait()
	close(results)
	counts := map[int]int{}
	for result := range results {
		counts[result]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
	var before string
	if err := store.database.QueryRow(`SELECT status FROM oauth_device_requests`).Scan(&before); err != nil {
		t.Fatal(err)
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
	var after string
	if err := reopened.database.QueryRow(`SELECT status FROM oauth_device_requests`).Scan(&after); err != nil || before != after {
		t.Fatalf("%s %s %v", before, after, err)
	}
}

func TestDeviceRequestDatabaseFailure(t *testing.T) {
	store := openTestStore(t)
	if _, err := store.database.Exec(`DROP TABLE oauth_device_requests`); err != nil {
		t.Fatal(err)
	}
	response := requestDeviceApproval(newHandler("test-key", store), "GET", "ABCD-1234", "", "test-key")
	if response.Code != 500 {
		t.Fatal(response.Code)
	}
}

func TestDeviceRequestDeny(t *testing.T) {
	store := openTestStore(t)
	seedDeviceRequest(t, store, "pending", time.Now().Add(time.Hour).Unix())
	handler := newHandler("test-key", store)
	for _, decision := range []string{"deny", "deny", "approve"} {
		response := requestDeviceApproval(handler, "POST", "ABCD-1234/decision", `{"decision":"`+decision+`"}`, "test-key")
		expected := 200
		if decision == "approve" {
			expected = 409
		}
		if response.Code != expected {
			t.Fatalf("%d %s", response.Code, response.Body.String())
		}
	}
}
