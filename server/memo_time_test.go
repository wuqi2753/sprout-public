package main

// REQ-070: time corrections preserve version and idempotency rules.
import (
	"fmt"
	"net/http"
	"testing"
)

func TestUpdateRecordingTime(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	created := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"original","created_at":"2026-10-02T08:30:00Z"}`, testNoteID), testCreateOpID)
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	path := notesPath + "/" + testNoteID
	for _, invalid := range []string{"", "bad", "2025-02-29T00:00:00Z"} {
		rejected := performRequest(handler, http.MethodPatch, path, fmt.Sprintf(`{"content":"original","base_version":1,"created_at":%q}`, invalid), testUpdateOpID)
		if rejected.Code != 400 {
			t.Fatalf("invalid time: %d %s", rejected.Code, rejected.Body.String())
		}
	}
	body := `{"content":"original","base_version":1,"created_at":"2024-02-29T23:59:47+08:00"}`
	updated := performRequest(handler, http.MethodPatch, path, body, testUpdateOpID)
	if updated.Code != 200 {
		t.Fatal(updated.Body.String())
	}
	note := decodeNote(t, updated)
	if note.CreatedAt != "2024-02-29T15:59:47Z" || note.Version != 2 || note.UpdatedAt == note.CreatedAt {
		t.Fatalf("unexpected note: %+v", note)
	}
	replay := performRequest(handler, http.MethodPatch, path, body, testUpdateOpID)
	// REQ-078: changing only the creation time still records the new version.
	requireChangeCount(t, store, 2)
	if replay.Body.String() != updated.Body.String() {
		t.Fatal("replay changed")
	}
	conflict := performRequest(handler, http.MethodPatch, path, `{"content":"changed","base_version":1,"created_at":"2020-01-01T00:00:00Z"}`, testDeleteOpID)
	if conflict.Code != 409 {
		t.Fatalf("conflict: %d", conflict.Code)
	}
	preserved := performRequest(handler, http.MethodPatch, path, `{"content":"changed","base_version":2}`, testDeleteOpID)
	if preserved.Code != 200 || decodeNote(t, preserved).CreatedAt != note.CreatedAt {
		t.Fatal(preserved.Body.String())
	}
	read := performRequest(handler, http.MethodGet, path, "", "")
	if decodeNote(t, read).CreatedAt != note.CreatedAt {
		t.Fatal("read lost time")
	}
}
