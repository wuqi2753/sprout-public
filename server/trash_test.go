package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	trashRestoreOpID = "0199a633-67aa-7e58-97f8-0196e3684ba3"
	trashPurgeOpID   = "0199a633-67aa-7e58-97f8-0196e3684ba4"
	trashClearOpID   = "0199a633-67aa-7e58-97f8-0196e3684ba5"
)

func TestTrashRestoreAndExpiry(t *testing.T) {
	store := openTestStore(t)
	clock := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return clock }
	handler := newHandler("test-key", store)
	created := performRequest(handler, http.MethodPost, notesPath,
		fmt.Sprintf(`{"note_id":%q,"content":"trash test","created_at":"2026-10-01T00:00:00Z"}`, testNoteID), testCreateOpID)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	deleted := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
	if deleted.Code != 200 {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body.String())
	}
	first := decodeNote(t, deleted)
	if first.DeletedAt == nil || first.ExpiresAt == nil || *first.ExpiresAt != clock.Add(30*24*time.Hour).Format(time.RFC3339Nano) {
		t.Fatalf("wrong expiry: %#v", first)
	}
	clock = clock.Add(5 * 24 * time.Hour)
	repeated := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
	if repeated.Body.String() != deleted.Body.String() {
		t.Fatalf("retry changed expiry: %s", repeated.Body.String())
	}
	active := performRequest(handler, http.MethodGet, notesPath, "", "")
	if active.Code != 200 || strings.TrimSpace(active.Body.String()) != `{"notes":[]}` {
		t.Fatalf("active list: %d %s", active.Code, active.Body.String())
	}
	listed := performRequest(handler, http.MethodGet, trashPath, "", "")
	var trash trashList
	if err := json.Unmarshal(listed.Body.Bytes(), &trash); err != nil || len(trash.Notes) != 1 {
		t.Fatalf("trash list: %d %s %v", listed.Code, listed.Body.String(), err)
	}
	restored := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/restore", `{"base_version":2}`, trashRestoreOpID)
	if restored.Code != 200 || decodeNote(t, restored).Version != 3 || decodeNote(t, restored).DeletedAt != nil {
		t.Fatalf("restore: %d %s", restored.Code, restored.Body.String())
	}
	if repeat := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/restore", `{"base_version":2}`, trashRestoreOpID); repeat.Body.String() != restored.Body.String() {
		t.Fatalf("restore retry: %d %s", repeat.Code, repeat.Body.String())
	}
	if active = performRequest(handler, http.MethodGet, notesPath, "", ""); active.Code != 200 || !containsNote(t, active.Body.Bytes(), testNoteID) {
		t.Fatalf("restored active list: %d %s", active.Code, active.Body.String())
	}
	deleted = performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":3}`, "0199a633-67aa-7e58-97f8-0196e3684ba6")
	if deleted.Code != 200 {
		t.Fatalf("second delete: %d %s", deleted.Code, deleted.Body.String())
	}
	clock = clock.Add(30*24*time.Hour - time.Nanosecond)
	if listed = performRequest(handler, http.MethodGet, trashPath, "", ""); listed.Code != 200 || !containsNote(t, listed.Body.Bytes(), testNoteID) {
		t.Fatalf("note missing just before expiry: %d %s", listed.Code, listed.Body.String())
	}
	clock = clock.Add(time.Nanosecond)
	expired := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/restore", `{"base_version":4}`, "0199a633-67aa-7e58-97f8-0196e3684ba7")
	if expired.Code != 410 {
		t.Fatalf("expired restore: %d %s", expired.Code, expired.Body.String())
	}
	if listed = performRequest(handler, http.MethodGet, trashPath, "", ""); listed.Code != 200 || strings.TrimSpace(listed.Body.String()) != `{"notes":[]}` {
		t.Fatalf("expired list: %d %s", listed.Code, listed.Body.String())
	}
}

func TestTrashLateDeleteUsesFirstServerReceipt(t *testing.T) {
	store := openTestStore(t)
	clock := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return clock }
	handler := newHandler("test-key", store)
	created := performRequest(handler, http.MethodPost, notesPath,
		fmt.Sprintf(`{"note_id":%q,"content":"offline","created_at":"2025-01-01T00:00:00Z"}`, testNoteID), testCreateOpID)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	clock = clock.Add(90 * 24 * time.Hour)
	deleted := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
	if deleted.Code != 200 {
		t.Fatalf("late delete: %d %s", deleted.Code, deleted.Body.String())
	}
	note := decodeNote(t, deleted)
	if note.DeletedAt == nil || note.ExpiresAt == nil || *note.DeletedAt != clock.Format(time.RFC3339Nano) ||
		*note.ExpiresAt != clock.Add(30*24*time.Hour).Format(time.RFC3339Nano) {
		t.Fatalf("late delete did not use server receipt time: %#v", note)
	}
	clock = clock.Add(12 * 24 * time.Hour)
	repeat := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
	if repeat.Code != 200 || repeat.Body.String() != deleted.Body.String() {
		t.Fatalf("late delete retry changed expiry: %d %s", repeat.Code, repeat.Body.String())
	}
	otherID := "018f4b64-8be1-7ee2-b608-9d26c750f57b"
	other := performRequest(handler, http.MethodPost, notesPath,
		fmt.Sprintf(`{"note_id":%q,"content":"later","created_at":"2025-01-01T00:00:00Z"}`, otherID), idToOperation(otherID))
	if other.Code != 201 {
		t.Fatalf("other create: %d %s", other.Code, other.Body.String())
	}
	other = performRequest(handler, http.MethodDelete, notesPath+"/"+otherID, `{"base_version":1}`, "0199a633-67aa-7e58-97f8-0196e3684bac")
	if other.Code != 200 {
		t.Fatalf("other delete: %d %s", other.Code, other.Body.String())
	}
	listed := performRequest(handler, http.MethodGet, trashPath, "", "")
	var trash trashList
	if err := json.Unmarshal(listed.Body.Bytes(), &trash); err != nil || len(trash.Notes) != 2 ||
		trash.Notes[0].NoteID != otherID || trash.Notes[1].NoteID != testNoteID {
		t.Fatalf("trash deletion order: %d %s %v", listed.Code, listed.Body.String(), err)
	}
	conflict := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/restore", `{"base_version":1}`, trashRestoreOpID)
	if conflict.Code != 409 {
		t.Fatalf("expected version conflict: %d %s", conflict.Code, conflict.Body.String())
	}
	invalid := performRequest(handler, http.MethodPost, notesPath+"/invalid/id/restore", `{"base_version":2}`, "0199a633-67aa-7e58-97f8-0196e3684ba9")
	if invalid.Code != 400 {
		t.Fatalf("expected invalid path rejection: %d %s", invalid.Code, invalid.Body.String())
	}
}

func containsNote(t *testing.T, body []byte, id string) bool {
	t.Helper()
	var response noteList
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	for _, n := range response.Notes {
		if n.NoteID == id {
			return true
		}
	}
	return false
}

func TestTrashPurgeAndClear(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	for _, id := range []string{testNoteID, "018f4b64-8be1-7ee2-b608-9d26c750f57b"} {
		created := performRequest(handler, http.MethodPost, notesPath,
			fmt.Sprintf(`{"note_id":%q,"content":"test","created_at":"2026-10-01T00:00:00Z"}`, id), idToOperation(id))
		if created.Code != 201 {
			t.Fatalf("create: %d %s", created.Code, created.Body.String())
		}
	}
	deleted := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID)
	if deleted.Code != 200 {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body.String())
	}
	purged := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":2}`, trashPurgeOpID)
	if purged.Code != 200 {
		t.Fatalf("purge: %d %s", purged.Code, purged.Body.String())
	}
	if repeat := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":2}`, trashPurgeOpID); repeat.Body.String() != purged.Body.String() {
		t.Fatalf("purge retry: %d %s", repeat.Code, repeat.Body.String())
	}
	if response := performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", ""); response.Code != 404 {
		t.Fatalf("purged get: %d %s", response.Code, response.Body.String())
	}
	cleared := performRequest(handler, http.MethodPost, trashPath, `{}`, trashClearOpID)
	if cleared.Code != 200 || strings.TrimSpace(cleared.Body.String()) != `{"purged":0,"version":1}` {
		t.Fatalf("clear: %d %s", cleared.Code, cleared.Body.String())
	}
	if active := performRequest(handler, http.MethodGet, notesPath, "", ""); !containsNote(t, active.Body.Bytes(), "018f4b64-8be1-7ee2-b608-9d26c750f57b") {
		t.Fatalf("clear removed normal note: %s", active.Body.String())
	}
}

func TestTrashPurgeActiveNoteWithoutTombstone(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	created := performRequest(handler, http.MethodPost, notesPath,
		fmt.Sprintf(`{"note_id":%q,"content":"hidden","created_at":"2026-10-01T00:00:00Z"}`, testNoteID), testCreateOpID)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	conflict := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":2}`, trashPurgeOpID)
	if conflict.Code != 409 {
		t.Fatalf("expected version conflict: %d %s", conflict.Code, conflict.Body.String())
	}
	purged := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":1}`, "0199a633-67aa-7e58-97f8-0196e3684bad")
	if purged.Code != 200 || decodeNote(t, purged).DeletedAt != nil {
		t.Fatalf("active purge: %d %s", purged.Code, purged.Body.String())
	}
	if repeated := performRequest(handler, http.MethodPost, notesPath+"/"+testNoteID+"/purge", `{"base_version":1}`, "0199a633-67aa-7e58-97f8-0196e3684bad"); repeated.Code != 200 || repeated.Body.String() != purged.Body.String() {
		t.Fatalf("active purge retry: %d %s", repeated.Code, repeated.Body.String())
	}
	for _, path := range []string{notesPath, trashPath} {
		listed := performRequest(handler, http.MethodGet, path, "", "")
		if listed.Code != 200 || !strings.Contains(listed.Body.String(), `"notes":[]`) {
			t.Fatalf("purged note visible at %s: %d %s", path, listed.Code, listed.Body.String())
		}
	}
}

func TestTrashKeepsReferencedObjectAndRetriesFailedFileCleanup(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	otherID := "018f4b64-8be1-7ee2-b608-9d26c750f57b"
	for _, id := range []string{testNoteID, otherID} {
		created := performRequest(handler, http.MethodPost, notesPath,
			fmt.Sprintf(`{"note_id":%q,"content":"attached","created_at":"2026-10-01T00:00:00Z"}`, id), idToOperation(id))
		if created.Code != 201 {
			t.Fatalf("create: %d %s", created.Code, created.Body.String())
		}
	}
	imageID := testNoteID + ":0"
	key, err := store.writeObject(imageID, strings.Repeat("a", 64), []byte("image bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.database.Exec(`INSERT INTO image_objects(image_id,media_type,sha256,bytes,object_key,size) VALUES(?,?,?,X'',?,?)`,
		imageID, "image/png", strings.Repeat("a", 64), key, 11); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{testNoteID, otherID} {
		if _, err := store.database.Exec(`INSERT INTO note_images(note_id,position,image_id) VALUES(?,0,?)`, id, imageID); err != nil {
			t.Fatal(err)
		}
	}
	for index, id := range []string{testNoteID, otherID} {
		if index == 1 {
			objectPath := filepath.Join(store.objectsDirectory, key)
			if err := os.Remove(objectPath); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(objectPath, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(objectPath, "obstruction"), []byte("x"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		tx, err := store.database.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := deleteNoteRecords(t.Context(), tx, id, store.now().UTC().Format(time.RFC3339Nano)); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if index == 1 {
			// This deliberately shared image ID cannot be created through the API.
			// Queue its final reference manually to exercise cleanup retry after commit.
			if _, err := tx.Exec(`INSERT INTO trash_object_cleanup(object_key) VALUES(?)`, key); err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
			if _, err := tx.Exec(`DELETE FROM image_objects WHERE image_id=?`, imageID); err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		cleanupError := store.cleanPendingObjectFiles()
		if index == 0 {
			if cleanupError != nil {
				t.Fatalf("first cleanup: %v", cleanupError)
			}
			var count int
			if err := store.database.QueryRow(`SELECT COUNT(*) FROM image_objects WHERE image_id=?`, imageID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("referenced object removed: count=%d err=%v", count, err)
			}
			if _, err := os.Stat(filepath.Join(store.objectsDirectory, key)); err != nil {
				t.Fatalf("referenced file removed: %v", err)
			}
		} else {
			if cleanupError == nil {
				t.Fatal("expected cleanup failure after commit")
			}
			var count int
			if err := store.database.QueryRow(`SELECT COUNT(*) FROM trash_object_cleanup WHERE object_key=?`, key).Scan(&count); err != nil || count != 1 {
				t.Fatalf("cleanup retry not queued: count=%d err=%v", count, err)
			}
			objectPath := filepath.Join(store.objectsDirectory, key)
			if err := os.Remove(filepath.Join(objectPath, "obstruction")); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(objectPath); err != nil {
				t.Fatal(err)
			}
			if err := store.cleanPendingObjectFiles(); err != nil {
				t.Fatalf("retry cleanup: %v", err)
			}
			if err := store.database.QueryRow(`SELECT COUNT(*) FROM trash_object_cleanup WHERE object_key=?`, key).Scan(&count); err != nil || count != 0 {
				t.Fatalf("cleanup queue retained: count=%d err=%v", count, err)
			}
		}
	}
}

func idToOperation(id string) string {
	if id == testNoteID {
		return testCreateOpID
	}
	return "0199a633-67aa-7e58-97f8-0196e3684ba8"
}
