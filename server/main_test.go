package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestImageNoteLifecycle(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	firstID := testNoteID + ":0"
	secondID := testNoteID + ":1"
	imageBytes := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 1, 2}
	for _, id := range []string{firstID, secondID} {
		request := httptest.NewRequest(http.MethodPut, objectsPath+id, bytes.NewReader(imageBytes))
		request.Header.Set("Authorization", "Bearer test-key")
		request.Header.Set("Content-Type", "image/png")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 201 {
			t.Fatalf("upload %s: %d %s", id, response.Code, response.Body.String())
		}
		repeatRequest := httptest.NewRequest(http.MethodPut, objectsPath+id, bytes.NewReader(imageBytes))
		repeatRequest.Header.Set("Authorization", "Bearer test-key")
		repeatRequest.Header.Set("Content-Type", "image/png")
		repeat := httptest.NewRecorder()
		handler.ServeHTTP(repeat, repeatRequest)
		if repeat.Code != 200 {
			t.Fatalf("repeat upload: %d %s", repeat.Code, repeat.Body.String())
		}
		conflictRequest := httptest.NewRequest(http.MethodPut, objectsPath+id, bytes.NewReader(append(append([]byte{}, imageBytes...), 3)))
		conflictRequest.Header.Set("Authorization", "Bearer test-key")
		conflictRequest.Header.Set("Content-Type", "image/png")
		conflict := httptest.NewRecorder()
		handler.ServeHTTP(conflict, conflictRequest)
		if conflict.Code != 409 || !strings.Contains(conflict.Body.String(), "image_id_conflict") {
			t.Fatalf("conflicting upload: %d %s", conflict.Code, conflict.Body.String())
		}
	}
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"","images":[%q,%q],"created_at":"2026-10-02T08:30:00Z"}`, testNoteID, secondID, firstID)
	missing := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"","images":[%q],"created_at":"2026-10-02T08:30:00Z"}`, testNoteID, testNoteID+":2"), testCreateOpID)
	if missing.Code != 400 || !strings.Contains(missing.Body.String(), "image_not_found") {
		t.Fatalf("missing image: %d %s", missing.Code, missing.Body.String())
	}
	created := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID)
	if created.Code != 201 || !bytes.Equal([]byte(decodeNote(t, created).Images[0]), []byte(secondID)) {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	if repeated := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID); repeated.Code != 201 || repeated.Body.String() != created.Body.String() {
		t.Fatalf("repeat: %d %s", repeated.Code, repeated.Body.String())
	}
	get := performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", "")
	if get.Code != 200 || len(decodeNote(t, get).Images) != 2 {
		t.Fatalf("get: %d %s", get.Code, get.Body.String())
	}
	image := performRequest(handler, http.MethodGet, objectsPath+firstID, "", "")
	if image.Code != 200 || image.Body.String() != string(imageBytes) || image.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("image read: %d", image.Code)
	}
	update := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, fmt.Sprintf(`{"content":"with text","images":[%q],"base_version":1}`, firstID), testUpdateOpID)
	if update.Code != 200 || len(decodeNote(t, update).Images) != 1 || decodeNote(t, update).Content != "with text" {
		t.Fatalf("update: %d %s", update.Code, update.Body.String())
	}
	get = performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", "")
	if get.Code != 200 || len(decodeNote(t, get).Images) != 1 {
		t.Fatalf("updated get: %d %s", get.Code, get.Body.String())
	}
	deleted := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":2}`, testDeleteOpID)
	if deleted.Code != 200 || decodeNote(t, deleted).DeletedAt == nil || len(decodeNote(t, deleted).Images) != 1 {
		t.Fatalf("image tombstone: %d %s", deleted.Code, deleted.Body.String())
	}
	retained := performRequest(handler, http.MethodGet, objectsPath+firstID, "", "")
	if retained.Code != 200 || !bytes.Equal(retained.Body.Bytes(), imageBytes) {
		t.Fatalf("retained image: %d", retained.Code)
	}
}

func TestImageNotePersistsAfterReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "images.db")
	store, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler("test-key", store)
	imageID := testNoteID + ":0"
	png := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 1, 2, 3}
	request := httptest.NewRequest(http.MethodPut, objectsPath+imageID, bytes.NewReader(png))
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set("Content-Type", "image/png")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 201 {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}
	created := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"caption","images":[%q],"created_at":"2026-10-02T08:30:00Z"}`, testNoteID, imageID), testCreateOpID)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openNoteStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	get := performRequest(newHandler("test-key", reopened), http.MethodGet, notesPath+"/"+testNoteID, "", "")
	if get.Code != 200 || len(decodeNote(t, get).Images) != 1 {
		t.Fatalf("reopened note: %d %s", get.Code, get.Body.String())
	}
	image := performRequest(newHandler("test-key", reopened), http.MethodGet, objectsPath+imageID, "", "")
	if image.Code != 200 || !bytes.Equal(image.Body.Bytes(), png) {
		t.Fatalf("reopened image: %d", image.Code)
	}
}

const (
	testNoteID     = "018f4b64-8be1-7ee2-b608-9d26c750f57a"
	testCreateOpID = "0199a633-67aa-7e58-97f8-0196e3684b9d"
	testUpdateOpID = "0199a633-67aa-7e58-97f8-0196e3684b9e"
	testDeleteOpID = "0199a633-67aa-7e58-97f8-0196e3684b9f"
)

func openTestStore(t *testing.T) *noteStore {
	t.Helper()
	store, err := openNoteStore(filepath.Join(t.TempDir(), "sprout.db"))
	if err != nil {
		t.Fatalf("open test store: %v", err)
	}
	t.Cleanup(func() { store.close() })
	return store
}

func performRequest(handler http.Handler, method, path, body, operationID string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer test-key")
	if operationID != "" {
		request.Header.Set("Idempotency-Key", operationID)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeNote(t *testing.T, response *httptest.ResponseRecorder) note {
	t.Helper()
	var result note
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode note: %v; body=%s", err, response.Body.String())
	}
	return result
}

func TestHealthEndpoint(t *testing.T) {
	handler := newHandler("test-key", openTestStore(t))
	tests := []struct {
		name, method, authorization string
		want                        int
	}{
		{"accepts valid API key", http.MethodGet, "Bearer test-key", 200},
		{"rejects missing API key", http.MethodGet, "", 401},
		{"rejects invalid API key", http.MethodGet, "Bearer wrong-key", 401},
		{"rejects unsupported method", http.MethodPost, "Bearer test-key", 405},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, healthPath, nil)
			request.Header.Set("Authorization", test.authorization)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d", response.Code, test.want)
			}
			if strings.Contains(response.Body.String(), "test-key") {
				t.Fatal("response contains API key")
			}
		})
	}
}

func TestNoteLifecycleAndIdempotency(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"first","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)

	created := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID)
	if created.Code != 201 || decodeNote(t, created).Version != 1 {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	repeated := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID)
	if repeated.Code != 201 || repeated.Body.String() != created.Body.String() {
		t.Fatalf("repeated create differs: %d %s", repeated.Code, repeated.Body.String())
	}

	reused := performRequest(handler, http.MethodPost, notesPath, strings.Replace(createBody, "first", "different", 1), testCreateOpID)
	if reused.Code != 409 || !strings.Contains(reused.Body.String(), "idempotency_key_reused") {
		t.Fatalf("reused key=%d %s", reused.Code, reused.Body.String())
	}

	updated := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"second","base_version":1}`, testUpdateOpID)
	if updated.Code != 200 || decodeNote(t, updated).Version != 2 {
		t.Fatalf("update=%d %s", updated.Code, updated.Body.String())
	}
	for range 2 {
		repeatedUpdate := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"second","base_version":1}`, testUpdateOpID)
		if repeatedUpdate.Code != updated.Code || repeatedUpdate.Body.String() != updated.Body.String() {
			t.Fatalf("repeated update differs: %d %s", repeatedUpdate.Code, repeatedUpdate.Body.String())
		}
	}
	conflict := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"stale","base_version":1}`, "0199a633-67aa-7e58-97f8-0196e3684ba0")
	if conflict.Code != 409 || !strings.Contains(conflict.Body.String(), "version_conflict") {
		t.Fatalf("conflict=%d %s", conflict.Code, conflict.Body.String())
	}
	var conflictBody versionConflictError
	if err := json.Unmarshal(conflict.Body.Bytes(), &conflictBody); err != nil || conflictBody.CurrentNote.Version != 2 || conflictBody.CurrentNote.Content != "second" {
		t.Fatalf("conflict current note=%#v err=%v", conflictBody, err)
	}

	deleted := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":2}`, testDeleteOpID)
	deletedNote := decodeNote(t, deleted)
	if deleted.Code != 200 || deletedNote.Version != 3 || deletedNote.DeletedAt == nil {
		t.Fatalf("delete=%d %s", deleted.Code, deleted.Body.String())
	}
	repeatedDelete := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":2}`, testDeleteOpID)
	if repeatedDelete.Code != 200 || decodeNote(t, repeatedDelete).Version != 3 {
		t.Fatalf("repeat delete=%d %s", repeatedDelete.Code, repeatedDelete.Body.String())
	}
	secondRepeatedDelete := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":2}`, testDeleteOpID)
	if secondRepeatedDelete.Code != deleted.Code || secondRepeatedDelete.Body.String() != deleted.Body.String() {
		t.Fatalf("second repeated delete differs: %d %s", secondRepeatedDelete.Code, secondRepeatedDelete.Body.String())
	}

	get := performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", "")
	if get.Code != 200 || decodeNote(t, get).DeletedAt == nil {
		t.Fatalf("get tombstone=%d %s", get.Code, get.Body.String())
	}
	staleDelete := performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":2}`, "0199a633-67aa-7e58-97f8-0196e3684ba2")
	var staleDeleteBody versionConflictError
	if err := json.Unmarshal(staleDelete.Body.Bytes(), &staleDeleteBody); staleDelete.Code != 409 || err != nil || staleDeleteBody.CurrentNote.Version != 3 || staleDeleteBody.CurrentNote.DeletedAt == nil {
		t.Fatalf("stale delete=%d %s err=%v", staleDelete.Code, staleDelete.Body.String(), err)
	}
	operation := performRequest(handler, http.MethodGet, operationsPath+testUpdateOpID, "", "")
	if operation.Code != 200 || !strings.Contains(operation.Body.String(), `"result_version":2`) {
		t.Fatalf("operation=%d %s", operation.Code, operation.Body.String())
	}
}

func TestPersistsIdempotencyAcrossRestart(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "sprout.db")
	store, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"persisted","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	first := performRequest(newHandler("test-key", store), http.MethodPost, notesPath, createBody, testCreateOpID)
	if first.Code != 201 {
		t.Fatalf("first=%d %s", first.Code, first.Body.String())
	}
	store.close()

	reopened, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	repeated := performRequest(newHandler("test-key", reopened), http.MethodPost, notesPath, createBody, testCreateOpID)
	if repeated.Code != 201 || repeated.Body.String() != first.Body.String() {
		t.Fatalf("restart repeat=%d %s", repeated.Code, repeated.Body.String())
	}
}

func TestNoteLifecyclePersistsAcrossRestarts(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "sprout.db")
	store, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"first","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	if response := performRequest(newHandler("test-key", store), http.MethodPost, notesPath, createBody, testCreateOpID); response.Code != 201 {
		t.Fatalf("create=%d %s", response.Code, response.Body.String())
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store, err = openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if current := decodeNote(t, performRequest(newHandler("test-key", store), http.MethodGet, notesPath+"/"+testNoteID, "", "")); current.Version != 1 || current.Content != "first" {
		t.Fatalf("created note after restart=%#v", current)
	}
	if response := performRequest(newHandler("test-key", store), http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"second","base_version":1}`, testUpdateOpID); response.Code != 200 {
		t.Fatalf("update=%d %s", response.Code, response.Body.String())
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store, err = openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if current := decodeNote(t, performRequest(newHandler("test-key", store), http.MethodGet, notesPath+"/"+testNoteID, "", "")); current.Version != 2 || current.Content != "second" {
		t.Fatalf("updated note after restart=%#v", current)
	}
	if response := performRequest(newHandler("test-key", store), http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":2}`, testDeleteOpID); response.Code != 200 {
		t.Fatalf("delete=%d %s", response.Code, response.Body.String())
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	store, err = openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.close()
	if current := decodeNote(t, performRequest(newHandler("test-key", store), http.MethodGet, notesPath+"/"+testNoteID, "", "")); current.Version != 3 || current.Content != "second" || current.DeletedAt == nil {
		t.Fatalf("tombstone after restart=%#v", current)
	}
}

func TestOperationIDReuseWithDifferentRequestIsRejected(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"first","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	created := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID)
	if created.Code != http.StatusCreated {
		t.Fatalf("create=%d %s", created.Code, created.Body.String())
	}
	requests := []struct {
		name, method, path, body string
	}{
		{"different method", http.MethodPatch, notesPath + "/" + testNoteID, `{"content":"changed","base_version":1}`},
		{"different resource", http.MethodPatch, notesPath + "/0199a633-67aa-7e58-97f8-0196e3684ba1", `{"content":"changed","base_version":1}`},
		{"different body", http.MethodPost, notesPath, strings.Replace(createBody, "first", "changed", 1)},
	}
	for _, request := range requests {
		t.Run(request.name, func(t *testing.T) {
			response := performRequest(handler, request.method, request.path, request.body, testCreateOpID)
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "idempotency_key_reused") {
				t.Fatalf("reuse=%d %s", response.Code, response.Body.String())
			}
		})
	}
	currentNote, err := store.getNote(t.Context(), testNoteID)
	if err != nil {
		t.Fatal(err)
	}
	if currentNote.Content != "first" || currentNote.Version != 1 {
		t.Fatalf("note changed after key reuse: %#v", currentNote)
	}
}

func TestConcurrentDuplicateCreateChangesStateOnce(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	body := fmt.Sprintf(`{"note_id":%q,"content":"concurrent","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	statuses := make(chan int, 2)
	var requests sync.WaitGroup
	for range 2 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			statuses <- performRequest(handler, http.MethodPost, notesPath, body, testCreateOpID).Code
		}()
	}
	requests.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusCreated {
			t.Fatalf("concurrent status=%d, want 201", status)
		}
	}
	var noteCount, operationCount int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM notes WHERE note_id=?`, testNoteID).Scan(&noteCount); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM processed_operations WHERE operation_id=?`, testCreateOpID).Scan(&operationCount); err != nil {
		t.Fatal(err)
	}
	if noteCount != 1 || operationCount != 1 {
		t.Fatalf("notes=%d operations=%d, want 1 each", noteCount, operationCount)
	}
}

func TestOperationWriteFailureRollsBackNote(t *testing.T) {
	store := openTestStore(t)
	if _, err := store.database.Exec(`CREATE TRIGGER reject_operation BEFORE INSERT ON processed_operations BEGIN SELECT RAISE(ABORT, 'injected operation failure'); END`); err != nil {
		t.Fatal(err)
	}
	handler := newHandler("test-key", store)
	body := fmt.Sprintf(`{"note_id":%q,"content":"rollback","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	response := performRequest(handler, http.MethodPost, notesPath, body, testCreateOpID)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var count int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM notes WHERE note_id=?`, testNoteID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("note count=%d, want rollback to zero", count)
	}
	operation := performRequest(handler, http.MethodGet, operationsPath+testCreateOpID, "", "")
	if operation.Code != http.StatusNotFound {
		t.Fatalf("operation status=%d body=%s", operation.Code, operation.Body.String())
	}
}

func TestNoteWriteFailureRollsBackOperation(t *testing.T) {
	store := openTestStore(t)
	if _, err := store.database.Exec(`CREATE TRIGGER reject_note BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'injected note failure'); END`); err != nil {
		t.Fatal(err)
	}
	handler := newHandler("test-key", store)
	body := fmt.Sprintf(`{"note_id":%q,"content":"rollback","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	response := performRequest(handler, http.MethodPost, notesPath, body, testCreateOpID)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	operation := performRequest(handler, http.MethodGet, operationsPath+testCreateOpID, "", "")
	if operation.Code != http.StatusNotFound {
		t.Fatalf("operation status=%d body=%s", operation.Code, operation.Body.String())
	}
}

func TestConcurrentDuplicateUpdateChangesVersionOnce(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"first","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	if response := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID); response.Code != http.StatusCreated {
		t.Fatalf("create=%d %s", response.Code, response.Body.String())
	}
	statuses := make(chan int, 2)
	var requests sync.WaitGroup
	for range 2 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			statuses <- performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"second","base_version":1}`, testUpdateOpID).Code
		}()
	}
	requests.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("concurrent status=%d, want 200", status)
		}
	}
	currentNote, err := store.getNote(t.Context(), testNoteID)
	if err != nil {
		t.Fatal(err)
	}
	if currentNote.Version != 2 || currentNote.Content != "second" {
		t.Fatalf("concurrent update state=%#v", currentNote)
	}
}

func TestConcurrentDuplicateDeleteChangesVersionOnce(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	createBody := fmt.Sprintf(`{"note_id":%q,"content":"first","created_at":"2026-10-02T08:30:00Z"}`, testNoteID)
	if response := performRequest(handler, http.MethodPost, notesPath, createBody, testCreateOpID); response.Code != http.StatusCreated {
		t.Fatalf("create=%d %s", response.Code, response.Body.String())
	}
	statuses := make(chan int, 2)
	var requests sync.WaitGroup
	for range 2 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			statuses <- performRequest(handler, http.MethodDelete, notesPath+"/"+testNoteID, `{"base_version":1}`, testDeleteOpID).Code
		}()
	}
	requests.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("concurrent status=%d, want 200", status)
		}
	}
	currentNote, err := store.getNote(t.Context(), testNoteID)
	if err != nil {
		t.Fatal(err)
	}
	if currentNote.Version != 2 || currentNote.DeletedAt == nil {
		t.Fatalf("concurrent delete state=%#v", currentNote)
	}
}

func TestRejectsInvalidMutationInput(t *testing.T) {
	handler := newHandler("test-key", openTestStore(t))
	tests := []struct {
		name, body, operationID string
		want                    int
	}{
		{"missing operation ID", fmt.Sprintf(`{"note_id":%q,"content":"x","created_at":"2026-10-02T08:30:00Z"}`, testNoteID), "", 400},
		{"invalid note ID", `{"note_id":"bad id","content":"x","created_at":"2026-10-02T08:30:00Z"}`, testCreateOpID, 400},
		{"blank content", fmt.Sprintf(`{"note_id":%q,"content":" ","created_at":"2026-10-02T08:30:00Z"}`, testNoteID), testCreateOpID, 400},
		{"unknown JSON field", fmt.Sprintf(`{"note_id":%q,"content":"x","created_at":"2026-10-02T08:30:00Z","extra":true}`, testNoteID), testCreateOpID, 400},
		{"multiple JSON values", fmt.Sprintf(`{"note_id":%q,"content":"x","created_at":"2026-10-02T08:30:00Z"} {}`, testNoteID), testCreateOpID, 400},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performRequest(handler, http.MethodPost, notesPath, test.body, test.operationID)
			if response.Code != test.want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestDatabaseReadFailuresReturnStructuredErrors(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	if err := store.close(); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		path string
	}{
		{"note", notesPath + "/" + testNoteID},
		{"operation", operationsPath + testCreateOpID},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performRequest(handler, http.MethodGet, test.path, "", "")
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var result apiError
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode error response: %v; body=%s", err, response.Body.String())
			}
			if result.Error.Code != "database_error" {
				t.Fatalf("error code=%q, want database_error", result.Error.Code)
			}
			if strings.Contains(response.Body.String(), "test-key") {
				t.Fatal("response contains API key")
			}
		})
	}
}

func TestInvalidStoredFieldsReturnDatabaseError(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	_, err := store.database.Exec(`INSERT INTO notes(note_id,content,version,created_at,updated_at) VALUES(?,?,1,?,?)`, testNoteID, " ", "2026-10-02T08:30:00Z", "2026-10-02T08:30:00Z")
	if err != nil {
		t.Fatal(err)
	}
	noteResponse := performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", "")
	if noteResponse.Code != 500 || !strings.Contains(noteResponse.Body.String(), `"code":"database_error"`) {
		t.Fatalf("invalid note=%d %s", noteResponse.Code, noteResponse.Body.String())
	}
	_, err = store.database.Exec(`INSERT INTO processed_operations(operation_id,note_id,operation,request_fingerprint,response_code,response_body,result_version,applied_at) VALUES(?,?,?,?,?,?,?,?)`, testCreateOpID, testNoteID, "invalid", "fingerprint", 201, `{}`, 1, "2026-10-02T08:30:00Z")
	if err != nil {
		t.Fatal(err)
	}
	operationResponse := performRequest(handler, http.MethodGet, operationsPath+testCreateOpID, "", "")
	if operationResponse.Code != 500 || !strings.Contains(operationResponse.Body.String(), `"code":"database_error"`) {
		t.Fatalf("invalid operation=%d %s", operationResponse.Code, operationResponse.Body.String())
	}
}

func TestNoteAPIRejectsUnauthorizedAndUnknownResources(t *testing.T) {
	handler := newHandler("secret-test-key", openTestStore(t))
	unauthorized := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, notesPath+"/"+testNoteID, nil)
	request.Header.Set("Authorization", "Bearer wrong-key")
	handler.ServeHTTP(unauthorized, request)
	if unauthorized.Code != 401 || strings.Contains(unauthorized.Body.String(), "secret-test-key") {
		t.Fatalf("unauthorized=%d %s", unauthorized.Code, unauthorized.Body.String())
	}
	for _, test := range []struct {
		path, code string
		status     int
	}{
		{notesPath + "/bad%20id", "invalid_note_id", 400},
		{notesPath + "/" + testNoteID, "note_not_found", 404},
		{operationsPath + "bad-id", "invalid_operation_id", 400},
		{operationsPath + testCreateOpID, "operation_not_found", 404},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, test.path, nil)
		request.Header.Set("Authorization", "Bearer secret-test-key")
		handler.ServeHTTP(response, request)
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) || strings.Contains(response.Body.String(), "secret-test-key") {
			t.Fatalf("path=%s status=%d body=%s", test.path, response.Code, response.Body.String())
		}
	}
}

func TestLoadConfig(t *testing.T) {
	config, err := loadConfig(func(name string) string { return map[string]string{"SPROUT_API_KEY": " test-key "}[name] })
	if err != nil {
		t.Fatal(err)
	}
	if config.listenAddress != defaultListenAddress || config.apiKey != "test-key" || config.databasePath != defaultDatabasePath {
		t.Fatalf("unexpected config: %#v", config)
	}
	if _, err = loadConfig(func(string) string { return "" }); err == nil || !strings.Contains(err.Error(), "SPROUT_API_KEY") {
		t.Fatalf("missing key error=%v", err)
	}
}
