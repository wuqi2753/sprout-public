package main

// REQ-078: real SQLite transactions, persistence and HTTP mutation regression.
import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func requireSyncExec(t *testing.T, store *noteStore, statement string, args ...any) {
	t.Helper()
	if _, err := store.database.Exec(statement, args...); err != nil {
		t.Fatal(err)
	}
}
func requireChangeCount(t *testing.T, store *noteStore, want int) {
	t.Helper()
	var count int
	if err := store.database.QueryRow(`SELECT count(*) FROM note_changes`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("changes=%d want=%d", count, want)
	}
}
func TestSyncTags(t *testing.T) {
	for _, test := range []struct {
		content string
		want    []string
	}{{"none", []string{}}, {"#中文 #a/b #A #a #中文##next", []string{"A", "a", "a/b", "next", "中文"}}, {"#a\uFEFF#b #c\u0085d", []string{"a", "b", "c\u0085d"}}} {
		if got := extractSyncTags(test.content); !reflect.DeepEqual(got, test.want) {
			t.Fatalf("tags=%q want=%q", got, test.want)
		}
	}
	for _, tags := range [][]string{nil, {""}, {"#x"}, {"a b"}, {"a\n"}} {
		if _, err := normalizeSubscriptionTags(tags); err == nil {
			t.Fatalf("accepted %q", tags)
		}
	}
}

func TestSyncMutationLifecycle(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	create := fmt.Sprintf(`{"note_id":%q,"content":"#a #b","created_at":"2026-10-01T00:00:00Z"}`, testNoteID)
	if r := performRequest(handler, http.MethodPost, notesPath, create, testCreateOpID); r.Code != 201 {
		t.Fatal(r.Body.String())
	}
	performRequest(handler, http.MethodPost, notesPath, create, testCreateOpID)
	requireChangeCount(t, store, 1)
	change, err := store.getNoteChange(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if change.Version != 1 || len(change.TagsBefore) != 0 || !reflect.DeepEqual(change.TagsAfter, []string{"a", "b"}) {
		t.Fatalf("create change %#v", change)
	}
	if r := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"#b #c","base_version":1}`, testUpdateOpID); r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"conflict","base_version":1}`, trashClearOpID)
	requireChangeCount(t, store, 2)
	change, err = store.getNoteChange(ctx, 2)
	if err != nil || !reflect.DeepEqual(change.TagsBefore, []string{"a", "b"}) || !reflect.DeepEqual(change.TagsAfter, []string{"b", "c"}) {
		t.Fatalf("update %#v %v", change, err)
	}
	for _, step := range []struct {
		method, path, body, op string
		version                int64
	}{{http.MethodDelete, notesPath + "/" + testNoteID, `{"base_version":2}`, testDeleteOpID, 3}, {http.MethodPost, notesPath + "/" + testNoteID + "/restore", `{"base_version":3}`, trashRestoreOpID, 4}, {http.MethodPost, notesPath + "/" + testNoteID + "/purge", `{"base_version":4}`, trashPurgeOpID, 5}} {
		if r := performRequest(handler, step.method, step.path, step.body, step.op); r.Code != 200 {
			t.Fatal(r.Body.String())
		}
		change, err := store.getNoteChange(ctx, step.version)
		if err != nil || change.Version != step.version {
			t.Fatalf("change %#v %v", change, err)
		}
		if step.version != 4 && len(change.TagsAfter) != 0 {
			t.Fatal("deleted note has active tags")
		}
	}
	performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":4}`, trashPurgeOpID)
	requireChangeCount(t, store, 5)
	if _, err := store.getNote(ctx, testNoteID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("purged note: %v", err)
	}
}

func TestSyncPhysicalCleanup(t *testing.T) {
	for _, mode := range []string{"purge", "clear", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			store := openTestStore(t)
			clock := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
			store.now = func() time.Time { return clock }
			h := newHandler("test-key", store)
			performRequest(h, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"#a","created_at":"2026-10-01T00:00:00Z"}`, testNoteID), testCreateOpID)
			performRequest(h, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
			switch mode {
			case "purge":
				if r := performRequest(h, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":2}`, trashPurgeOpID); r.Code != 200 {
					t.Fatal(r.Body.String())
				}
			case "clear":
				if r := performRequest(h, http.MethodPost, trashPath, `{}`, trashClearOpID); r.Code != 200 {
					t.Fatal(r.Body.String())
				}
			case "expiry":
				clock = clock.Add(30 * 24 * time.Hour)
				if err := store.purgeExpiredNotes(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			requireChangeCount(t, store, 3)
			change, err := store.getNoteChange(context.Background(), 3)
			if err != nil || change.Version != 3 || len(change.TagsBefore) != 0 || len(change.TagsAfter) != 0 {
				t.Fatalf("terminal %#v %v", change, err)
			}
			if err := store.purgeExpiredNotes(context.Background()); err != nil {
				t.Fatal(err)
			}
			requireChangeCount(t, store, 3)
		})
	}
}

func TestSyncRecordFailureRollsBack(t *testing.T) {
	store := openTestStore(t)
	h := newHandler("test-key", store)
	create := fmt.Sprintf(`{"note_id":%q,"content":"#a","created_at":"2026-10-01T00:00:00Z"}`, testNoteID)
	requireSyncExec(t, store, `CREATE TRIGGER fail_changes BEFORE INSERT ON note_changes BEGIN SELECT RAISE(ABORT,'injected failure'); END`)
	if r := performRequest(h, http.MethodPost, notesPath, create, testCreateOpID); r.Code != 500 {
		t.Fatal(r.Body.String())
	}
	requireChangeCount(t, store, 0)
	if _, err := store.getNote(context.Background(), testNoteID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	requireSyncExec(t, store, `DROP TRIGGER fail_changes`)
	if r := performRequest(h, http.MethodPost, notesPath, create, testCreateOpID); r.Code != 201 {
		t.Fatal(r.Body.String())
	}
	requireSyncExec(t, store, `CREATE TRIGGER fail_changes BEFORE INSERT ON note_changes BEGIN SELECT RAISE(ABORT,'injected failure'); END`)
	if r := performRequest(h, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"changed","base_version":1}`, testUpdateOpID); r.Code != 500 {
		t.Fatal(r.Body.String())
	}
	if r := performRequest(h, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":1}`, trashPurgeOpID); r.Code != 500 {
		t.Fatal(r.Body.String())
	}
	n, err := store.getNote(context.Background(), testNoteID)
	if err != nil || n.Version != 1 || n.Content != "#a" {
		t.Fatalf("rollback %#v %v", n, err)
	}
	requireChangeCount(t, store, 1)
}

func TestSyncSubscriptionPersistence(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "sync.db")
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
	subscription, err := store.createWorkspaceSubscription(ctx, "owner", []string{"b", "a", "a"})
	if err != nil {
		t.Fatal(err)
	}
	cursor, receipt := "opaque-position", "secret-receipt"
	pending := subscriptionProgress{PendingCursor: &cursor, PendingReceipt: &receipt}
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, subscription.Progress, pending); err != nil {
		t.Fatal(err)
	}
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, subscription.Progress, pending); !errors.Is(err, errSubscriptionProgressConflict) {
		t.Fatalf("stale update %v", err)
	}
	if _, err := store.getWorkspaceSubscription(ctx, "other", subscription.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "other", subscription.ID, pending, subscriptionProgress{}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	// REQ-085 permits tags to change while identity remains fixed.
	if _, err := store.database.Exec(`UPDATE workspace_subscriptions SET tags=tags WHERE subscription_id=?`, subscription.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.database.Exec(`UPDATE workspace_subscriptions SET owner_id='other' WHERE subscription_id=?`, subscription.ID); err == nil {
		t.Fatal("owner changed")
	}
	if _, err := store.database.Exec(`UPDATE workspace_subscriptions SET pending_receipt=NULL WHERE subscription_id=?`, subscription.ID); err == nil {
		t.Fatal("unpaired pending accepted")
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store = nil
	store, err = openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.getWorkspaceSubscription(ctx, "owner", subscription.ID)
	if err != nil || !reflect.DeepEqual(got.Tags, []string{"a", "b"}) || !sameSubscriptionProgress(got.Progress, pending) {
		t.Fatalf("reopen %#v %v", got, err)
	}
	requireSyncExec(t, store, `CREATE TRIGGER fail_progress BEFORE UPDATE ON workspace_subscriptions BEGIN SELECT RAISE(ABORT,'injected failure'); END`)
	acknowledged := subscriptionProgress{AcknowledgedCursor: &cursor, LastAcknowledgedReceipt: &receipt}
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, pending, acknowledged); err == nil {
		t.Fatal("failure ignored")
	}
	got, err = store.getWorkspaceSubscription(ctx, "owner", subscription.ID)
	if err != nil || !sameSubscriptionProgress(got.Progress, pending) {
		t.Fatal("failed update changed progress")
	}
	requireSyncExec(t, store, `DROP TRIGGER fail_progress`)
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, pending, acknowledged); err != nil {
		t.Fatal(err)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store = nil
	store, err = openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err = store.getWorkspaceSubscription(ctx, "owner", subscription.ID)
	if err != nil || !sameSubscriptionProgress(got.Progress, acknowledged) {
		t.Fatal("confirmed progress not persisted")
	}
}

func TestSyncConcurrentSubscriptionUpdates(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	subscription, err := store.createWorkspaceSubscription(ctx, "owner", []string{"a"})
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, position := range []string{"one", "two"} {
		workers.Add(1)
		go func(cursor string) {
			defer workers.Done()
			receipt := "receipt-" + cursor
			results <- store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, subscriptionProgress{}, subscriptionProgress{PendingCursor: &cursor, PendingReceipt: &receipt})
		}(position)
	}
	workers.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, errSubscriptionProgressConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("success=%d conflicts=%d", success, conflicts)
	}
	got, err := store.getWorkspaceSubscription(ctx, "owner", subscription.ID)
	if err != nil || got.Progress.AcknowledgedCursor != nil {
		t.Fatal("pending write advanced acknowledged progress")
	}
	cursor, receipt := "changed", "receipt"
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, got.Progress, subscriptionProgress{AcknowledgedCursor: &cursor, PendingCursor: &cursor, PendingReceipt: &receipt}); err == nil {
		t.Fatal("pending write accepted cursor advance")
	}
	if err := store.updateWorkspaceSubscriptionProgress(ctx, "owner", subscription.ID, got.Progress, subscriptionProgress{PendingCursor: &cursor}); err == nil {
		t.Fatal("unpaired progress accepted")
	}
}
