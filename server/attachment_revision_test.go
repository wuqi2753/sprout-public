package main

// REQ-048: replacement uploads never overwrite earlier attachment bytes.
import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAttachmentRevisions(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	revision := "11111111-1111-4111-8111-111111111111"
	oldFile := testNoteID + ":file"
	newFile := testNoteID + ":" + revision + ":file"
	for index, id := range []string{oldFile, newFile} {
		response := uploadTestFile(handler, id, "note.pdf", "application/pdf", []byte(fmt.Sprintf("%%PDF-1.7\nrevision %d", index)))
		if response.Code != 201 {
			t.Fatalf("upload: %d %s", response.Code, response.Body.String())
		}
	}
	created := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"","files":[%q],"created_at":"2026-10-05T00:00:00Z"}`, testNoteID, oldFile), testCreateOpID)
	// REQ-078: object uploads do not record changes; attaching them does.
	requireChangeCount(t, store, 1)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	updated := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, fmt.Sprintf(`{"files":[%q],"base_version":1}`, newFile), testUpdateOpID)
	if updated.Code != 200 {
		t.Fatalf("replace: %d %s", updated.Code, updated.Body.String())
	}
	if decodeNote(t, updated).Files[0] != newFile {
		t.Fatal("replacement reference missing")
	}
	original := performRequest(handler, http.MethodGet, filesPath+oldFile, "", "")
	if original.Code != 200 || !bytes.Contains(original.Body.Bytes(), []byte("revision 0")) {
		t.Fatal("old bytes changed")
	}
	if validNoteFiles("other", []string{newFile}, nil) || validNoteFiles(testNoteID, []string{newFile, newFile}, nil) {
		t.Fatal("invalid file relation accepted")
	}

	imageID := testNoteID + ":" + revision + ":0"
	imageBytes := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 1, 2}
	request := httptest.NewRequest(http.MethodPut, objectsPath+imageID, bytes.NewReader(imageBytes))
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set("Content-Type", "image/png")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 201 {
		t.Fatalf("versioned image: %d %s", response.Code, response.Body.String())
	}
	imageUpdate := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID,
		fmt.Sprintf(`{"content":"","files":[],"images":[%q],"base_version":2}`, imageID), "22222222-2222-4222-8222-222222222222")
	if imageUpdate.Code != 200 || decodeNote(t, imageUpdate).Images[0] != imageID {
		t.Fatalf("versioned image reference: %d %s", imageUpdate.Code, imageUpdate.Body.String())
	}
	requireChangeCount(t, store, 3)
	for _, originalFile := range []string{oldFile, newFile} {
		retained := performRequest(handler, http.MethodGet, filesPath+originalFile, "", "")
		if retained.Code != 200 {
			t.Fatalf("retained file missing: %d", retained.Code)
		}
	}
	if !validNoteImageIDs(testNoteID, []string{imageID, testNoteID + ":1"}) || validNoteImageIDs("other", []string{imageID}) || validNoteImageIDs(testNoteID, []string{imageID, imageID}) {
		t.Fatal("image ownership or duplicate validation failed")
	}
	if imageIDPattern.MatchString(testNoteID+":bad:0") || fileIDPattern.MatchString(testNoteID+":bad:file") {
		t.Fatal("invalid revision accepted")
	}
}
