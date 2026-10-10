package main

// REQ-078: upgrade without inventing history, monotonic IDs and invalid storage.
import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"
)

func TestSyncMigrationAndChangeIDPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "existing.db")
	store, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if store != nil {
			if err := store.close(); err != nil {
				t.Error(err)
			}
		}
	})
	handler := newHandler("test-key", store)
	body := fmt.Sprintf(`{"note_id":%q,"content":"#existing","created_at":"2026-10-01T00:00:00Z"}`, testNoteID)
	if r := performRequest(handler, http.MethodPost, notesPath, body, testCreateOpID); r.Code != 201 {
		t.Fatal(r.Body.String())
	}
	// Simulate an existing database from before the two-table migration.
	requireSyncExec(t, store, `DROP TABLE workspace_subscriptions; DROP TABLE note_changes`)
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store = nil
	for attempt := 0; attempt < 2; attempt++ {
		store, err = openNoteStore(path)
		if err != nil {
			t.Fatal(err)
		}
		for table, want := range map[string]int{"note_changes": 6, "workspace_subscriptions": 7} {
			var count int
			if err := store.database.QueryRow(`SELECT count(*) FROM pragma_table_info(?)`, table).Scan(&count); err != nil || count != want {
				t.Fatalf("%s columns=%d %v", table, count, err)
			}
		}
		requireChangeCount(t, store, 0)
		n, err := store.getNote(context.Background(), testNoteID)
		if err != nil || n.Content != "#existing" || n.Version != 1 {
			t.Fatalf("migration changed note %#v %v", n, err)
		}
		if r := performRequest(newHandler("test-key", store), http.MethodPost, notesPath, body, testCreateOpID); r.Code != 201 {
			t.Fatal("migration lost idempotency")
		}
		if err := store.close(); err != nil {
			t.Fatal(err)
		}
		store = nil
	}
	store, err = openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if r := performRequest(newHandler("test-key", store), http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"#changed","base_version":1}`, testUpdateOpID); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	requireSyncExec(t, store, `DELETE FROM note_changes`)
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store = nil
	store, err = openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if r := performRequest(newHandler("test-key", store), http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"#again","base_version":2}`, testDeleteOpID); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	change, err := store.getNoteChange(context.Background(), 2)
	if err != nil || change.Version != 3 {
		t.Fatalf("change ID reused %#v %v", change, err)
	}
}

func TestSyncCorruptStorageRejected(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	subscription, err := store.createWorkspaceSubscription(ctx, "owner", []string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	requireSyncExec(t, store, `DROP TRIGGER workspace_subscription_identity_fixed`)
	for _, encoded := range []string{`[null]`, `[1]`, `[""]`, `["a","a"]`, `["z","a"]`} {
		requireSyncExec(t, store, `UPDATE workspace_subscriptions SET tags=? WHERE subscription_id=?`, encoded, subscription.ID)
		if _, err := store.getWorkspaceSubscription(ctx, "owner", subscription.ID); err == nil {
			t.Fatalf("accepted tags %s", encoded)
		}
	}
	requireSyncExec(t, store, `INSERT INTO note_changes(note_id,note_version,tags_before,tags_after,changed_at) VALUES(?,1,'[]','[]','invalid')`, testNoteID)
	if _, err := store.getNoteChange(ctx, 1); err == nil {
		t.Fatal("invalid time accepted")
	}
	requireSyncExec(t, store, `UPDATE note_changes SET changed_at='2026-10-09T00:00:00Z',tags_after='[null]'`)
	if _, err := store.getNoteChange(ctx, 1); err == nil {
		t.Fatal("invalid tag accepted")
	}
}
