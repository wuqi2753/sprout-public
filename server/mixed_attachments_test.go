package main

// REQ-053: real SQLite and HTTP mutations verify ordered mixed references and migration.
import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func uploadMixedFixtures(t *testing.T, handler http.Handler, noteID string) ([]string, []string) {
	t.Helper()
	files := []string{}
	images := []string{}
	for position := 0; position < 5; position++ {
		fileID := fmt.Sprintf("%s:11111111-1111-4111-8111-%012d:file", noteID, position)
		response := uploadTestFile(handler, fileID, fmt.Sprintf("file-%d.pdf", position), "application/pdf", []byte(fmt.Sprintf("%%PDF-1.7\nfile %d", position)))
		if response.Code != 201 {
			t.Fatalf("file upload: %d %s", response.Code, response.Body.String())
		}
		files = append(files, fileID)
		imageID := fmt.Sprintf("%s:%d", noteID, position)
		request := httptest.NewRequest(http.MethodPut, objectsPath+imageID, bytes.NewReader([]byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}))
		request.Header.Set("Authorization", "Bearer test-key")
		request.Header.Set("Content-Type", "image/png")
		imageResponse := httptest.NewRecorder()
		handler.ServeHTTP(imageResponse, request)
		if imageResponse.Code != 201 {
			t.Fatalf("image upload: %d %s", imageResponse.Code, imageResponse.Body.String())
		}
		images = append(images, imageID)
	}
	return files, images
}

func TestMixedAttachmentLimitsAndOrder(t *testing.T) {
	for _, combination := range []struct{ images, files int }{{5, 0}, {0, 5}, {2, 3}} {
		t.Run(fmt.Sprintf("%d-images-%d-files", combination.images, combination.files), func(t *testing.T) {
			store := openTestStore(t)
			handler := newHandler("test-key", store)
			files, images := uploadMixedFixtures(t, handler, testNoteID)
			selectedFiles, selectedImages := files[:combination.files], images[:combination.images]
			body, err := json.Marshal(map[string]any{"note_id": testNoteID, "content": "", "files": selectedFiles, "images": selectedImages, "created_at": "2026-10-05T00:00:00Z"})
			if err != nil {
				t.Fatal(err)
			}
			created := performRequest(handler, http.MethodPost, notesPath, string(body), testCreateOpID)
			if created.Code != 201 {
				t.Fatalf("create: %d %s", created.Code, created.Body.String())
			}
			n := decodeNote(t, created)
			if !reflect.DeepEqual(n.Files, selectedFiles) || !reflect.DeepEqual(n.Images, selectedImages) {
				t.Fatalf("wrong order: %#v", n)
			}
			for index, metadata := range n.FileAttachments {
				if metadata.ID != selectedFiles[index] || metadata.Name != fmt.Sprintf("file-%d.pdf", index) {
					t.Fatalf("wrong metadata: %#v", metadata)
				}
			}
			// Partial updates must count the unchanged attachment collection too.
			patch := fmt.Sprintf(`{"images":[%q],"base_version":1}`, images[0])
			if combination.files < 5 {
				encoded, _ := json.Marshal(files)
				patch = fmt.Sprintf(`{"files":%s,"base_version":1}`, encoded)
			}
			rejected := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, patch, testUpdateOpID)
			if rejected.Code != 400 || !strings.Contains(rejected.Body.String(), "too_many_attachments") {
				t.Fatalf("accepted excess: %d %s", rejected.Code, rejected.Body.String())
			}
			unchanged := decodeNote(t, performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", ""))
			if unchanged.Version != 1 || !reflect.DeepEqual(unchanged.Files, selectedFiles) {
				t.Fatal("rejected update changed state")
			}
			// A rejected operation ID can be retried with a valid replacement.
			ordered := []string{files[2], files[0], files[1]}
			encoded, _ := json.Marshal(map[string]any{"images": images[:2], "files": ordered, "base_version": 1})
			updated := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, string(encoded), testUpdateOpID)
			if updated.Code != 200 || !reflect.DeepEqual(decodeNote(t, updated).Files, ordered) {
				t.Fatalf("mixed update: %d %s", updated.Code, updated.Body.String())
			}
			repeated := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, string(encoded), testUpdateOpID)
			if repeated.Code != 200 || decodeNote(t, repeated).Version != 2 {
				t.Fatal("idempotent retry failed")
			}
		})
	}
}

func TestMixedInvalidReferencesRollback(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	files, images := uploadMixedFixtures(t, handler, testNoteID)
	for _, fixture := range []struct {
		files  []string
		images []string
		code   string
	}{
		{files, images[:1], "too_many_attachments"},
		{[]string{files[0], files[0]}, nil, "invalid_files"},
		{[]string{files[0], "other:file"}, nil, "invalid_files"},
		{[]string{files[0], testNoteID + ":file"}, nil, "file_not_found"},
	} {
		encoded, _ := json.Marshal(map[string]any{"note_id": testNoteID, "content": "", "images": fixture.images, "files": fixture.files, "created_at": "2026-10-05T00:00:00Z"})
		response := performRequest(handler, http.MethodPost, notesPath, string(encoded), testCreateOpID)
		if response.Code != 400 || !strings.Contains(response.Body.String(), fixture.code) {
			t.Fatalf("unexpected failure: %d %s", response.Code, response.Body.String())
		}
		var count int
		if err := store.database.QueryRow("SELECT COUNT(*) FROM notes").Scan(&count); err != nil || count != 0 {
			t.Fatal("partial create survived")
		}
	}
}

func TestSingleFileRelationMigration(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "legacy.db")
	store, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler("test-key", store)
	id := testNoteID + ":file"
	original := []byte("%PDF-1.7\nretained")
	if response := uploadTestFile(handler, id, "legacy.pdf", "application/pdf", original); response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	created := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"old","files":[%q],"created_at":"2026-10-05T00:00:00Z"}`, testNoteID, id), testCreateOpID)
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	_, err = store.database.Exec(`ALTER TABLE note_files RENAME TO note_files_new;
 CREATE TABLE note_files (note_id TEXT PRIMARY KEY REFERENCES notes(note_id), file_id TEXT NOT NULL UNIQUE REFERENCES file_objects(file_id));
 INSERT INTO note_files SELECT note_id,file_id FROM note_files_new;
 DROP TABLE note_files_new;`)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		store, err = openNoteStore(databasePath)
		if err != nil {
			t.Fatal(err)
		}
		handler = newHandler("test-key", store)
		n := decodeNote(t, performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", ""))
		if n.Version != 1 || len(n.Files) != 1 || n.Files[0] != id || n.FileAttachments[0].Name != "legacy.pdf" {
			t.Fatalf("migration changed note: %#v", n)
		}
		replayed := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"old","files":[%q],"created_at":"2026-10-05T00:00:00Z"}`, testNoteID, id), testCreateOpID)
		if replayed.Code != created.Code || replayed.Body.String() != created.Body.String() {
			t.Fatal("migration changed the prior operation log")
		}
		downloaded := performRequest(handler, http.MethodGet, filesPath+id, "", "")
		if downloaded.Code != 200 || !bytes.Equal(downloaded.Body.Bytes(), original) {
			t.Fatal("migration changed bytes")
		}
		if attempt == 1 {
			newID := testNoteID + ":11111111-1111-4111-8111-111111111111:file"
			if upload := uploadTestFile(handler, newID, "second.pdf", "application/pdf", original); upload.Code != 201 {
				t.Fatal(upload.Body.String())
			}
			update := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, fmt.Sprintf(`{"files":[%q,%q],"base_version":1}`, id, newID), testUpdateOpID)
			if update.Code != 200 || len(decodeNote(t, update).Files) != 2 {
				t.Fatalf("append after migration: %d %s", update.Code, update.Body.String())
			}
		}
		if err := store.close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLegacySixImagesRemainReadable(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	_, images := uploadMixedFixtures(t, handler, testNoteID)
	encoded, _ := json.Marshal(map[string]any{"note_id": testNoteID, "content": "legacy", "images": images, "created_at": "2026-10-05T00:00:00Z"})
	created := performRequest(handler, http.MethodPost, notesPath, string(encoded), testCreateOpID)
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	// Simulate a relationship written by the former nine-image version.
	id := testNoteID + ":5"
	_, err := store.database.Exec(`INSERT INTO image_objects(image_id,media_type,sha256,bytes,object_key,size) SELECT ?,media_type,sha256,bytes,object_key,size FROM image_objects WHERE image_id=?`, id, images[0])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.database.Exec(`INSERT INTO note_images(note_id,position,image_id) VALUES(?,5,?)`, testNoteID, id); err != nil {
		t.Fatal(err)
	}
	read := performRequest(handler, http.MethodGet, notesPath+"/"+testNoteID, "", "")
	if read.Code != 200 || len(decodeNote(t, read).Images) != 6 {
		t.Fatalf("legacy read: %d %s", read.Code, read.Body.String())
	}
	excess := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, `{"content":"changed","base_version":1}`, testUpdateOpID)
	if excess.Code != 400 || !strings.Contains(excess.Body.String(), "too_many_attachments") {
		t.Fatal(excess.Body.String())
	}
	encoded, _ = json.Marshal(map[string]any{"images": images, "base_version": 1})
	reduced := performRequest(handler, http.MethodPatch, notesPath+"/"+testNoteID, string(encoded), testUpdateOpID)
	if reduced.Code != 200 || len(decodeNote(t, reduced).Images) != 5 {
		t.Fatal(reduced.Body.String())
	}
}
