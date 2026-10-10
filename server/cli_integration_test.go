package main

// REQ-079..086: opt-in integration against the real npm CLI, not a mock server.
import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCLIRealServerSync(t *testing.T) {
	entry := os.Getenv("SPROUT_CLI_ENTRY")
	if entry == "" {
		t.Skip("set SPROUT_CLI_ENTRY to the built cli/dist/main.js for real CLI integration")
	}
	entry, err := filepath.Abs(entry)
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(root, "workspace")
	credentials := filepath.Join(root, "credentials")
	for _, path := range []string{workspace, credentials} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	server := httptest.NewServer(handler)
	defer server.Close()
	token := seedBusinessToken(t, store, cliScope)
	var grant string
	if err := store.database.QueryRow(`SELECT grant_id FROM oauth_tokens WHERE token_hash=?`, tokenHash(token)).Scan(&grant); err != nil {
		t.Fatal(err)
	}
	tx, err := store.database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	issued, err := issueOAuthTokens(httptest.NewRequest("POST", "/oauth/token", nil), tx, grant, cliScope, store.now().Unix(), store.now().Unix()+10000)
	if err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	fields := issued.body.(map[string]any)
	// REQ-099: seed a private workspace credential, not the old Server-wide file.
	workspaceID := "8e6a4a42-f68d-421e-9626-26f2e9901c5c"
	if err := os.MkdirAll(filepath.Join(workspace, ".sprout"), 0700); err != nil {
		t.Fatal(err)
	}
	identity, err := json.Marshal(map[string]any{"schema": 1, "workspace_id": workspaceID, "root_hash": tokenHash(workspace)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, ".sprout", "identity.json"), identity, 0600); err != nil {
		t.Fatal(err)
	}
	credentials = filepath.Join(credentials, "workspaces", workspaceID)
	if err := os.MkdirAll(credentials, 0700); err != nil {
		t.Fatal(err)
	}
	saved := map[string]any{"server": server.URL, "workspace_id": workspaceID, "access_token": fields["access_token"], "refresh_token": fields["refresh_token"], "expires_at": time.Now().UnixMilli() + 1000, "uncertain": false}
	encoded, err := json.Marshal(saved)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credentials, tokenHash(server.URL)+".json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		t.Helper()
		if args[0] == "tags" || args[0] == "logout" {
			args = append(args, "--workspace", workspace)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "node", append([]string{entry}, args...)...)
		command.Env = append(os.Environ(), "SPROUT_CLI_CONFIG_DIR="+filepath.Dir(filepath.Dir(credentials)))
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("CLI %s failed: %v\n%s", args[0], err, output)
		}
		return string(output)
	}
	for i := 0; i < 55; i++ {
		seedSyncNote(t, store, fmt.Sprintf("memo%03d", i), "#a original")
	}
	seedSyncNote(t, store, "old-b", "#b historical")
	fileID := testNoteID + ":file"
	pdf := []byte("%PDF-1.7\nintegration")
	if w := uploadTestFile(handler, fileID, "fixture.pdf", "application/pdf", pdf); w.Code != 201 {
		t.Fatal(w.Code)
	}
	if w := performRequest(handler, "POST", notesPath, fmt.Sprintf(`{"note_id":%q,"content":"#a attached","files":[%q],"created_at":"2026-10-09T00:00:00Z"}`, testNoteID, fileID), testCreateOpID); w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	run("tags", "--server", server.URL)
	run("init", "--server", server.URL, "--workspace", workspace, "--tags", "a", "--materials", "materials")
	run("status", "--workspace", workspace)
	run("sync", "--workspace", workspace)
	readIndex := func() map[string]map[string]any {
		t.Helper()
		encoded, err := os.ReadFile(filepath.Join(workspace, "materials", "index.json"))
		if err != nil {
			t.Fatal(err)
		}
		var index struct {
			Notes map[string]map[string]any `json:"notes"`
		}
		if err := json.Unmarshal(encoded, &index); err != nil {
			t.Fatal(err)
		}
		return index.Notes
	}
	if len(readIndex()) != 56 {
		t.Fatal("initial material count", len(readIndex()))
	}
	if content, err := os.ReadFile(filepath.Join(workspace, "materials", tokenHash(string(pdf))+".bin")); err != nil || string(content) != string(pdf) {
		t.Fatal("attachment bytes", err)
	}
	changeSyncNote(t, store, "memo000", "#a revised", false, false)
	changeSyncNote(t, store, "memo001", "#a original", true, false)
	run("sync", "--workspace", workspace)
	index := readIndex()
	if index["memo000"]["version"] != float64(2) || index["memo001"]["updating"] != false {
		t.Fatal("incremental states", index["memo000"], index["memo001"])
	}
	if _, err := os.Stat(filepath.Join(workspace, "materials", tokenHash("memo001")+".md")); err != nil {
		t.Fatal("stop deleted local content", err)
	}
	run("set-tags", "--workspace", workspace, "--tags", "a,b", "--backfill", "yes")
	run("sync", "--workspace", workspace)
	if _, exists := readIndex()["old-b"]; !exists {
		t.Fatal("backfill omitted old b")
	}
	seedSyncNote(t, store, "old-c", "#c historical")
	run("sync", "--workspace", workspace)
	run("set-tags", "--workspace", workspace, "--tags", "a,b,c", "--backfill", "no")
	run("sync", "--workspace", workspace)
	if _, exists := readIndex()["old-c"]; exists {
		t.Fatal("no-backfill fetched history")
	}
	seedSyncNote(t, store, "new-c", "#c new")
	run("sync", "--workspace", workspace)
	if _, exists := readIndex()["new-c"]; !exists {
		t.Fatal("new tag increment omitted")
	}
	run("logout", "--server", server.URL)
	t.Log("real CLI: refresh, tags, init, status, multi-page initial sync, file download, incremental update/stop, backfill yes/no and logout passed")
}
