package main

// REQ-042: original bytes, failure boundaries, migration and backup recovery.
import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uploadTestFile(handler http.Handler, id, name, mediaType string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, filesPath+id, bytes.NewReader(body))
	hash := sha256.Sum256(body)
	request.Header.Set("Authorization", "Bearer test-key")
	request.Header.Set("Content-Type", mediaType)
	request.Header.Set("X-File-Name", url.PathEscape(name))
	request.Header.Set("X-File-SHA256", hex.EncodeToString(hash[:]))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func spreadsheetFixture(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for name, contents := range map[string]string{"[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>"} {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestOrdinaryFileLifecycle(t *testing.T) {
	for _, fixture := range []struct {
		name, mediaType string
		body            []byte
	}{
		{"银行.pdf", "application/pdf", []byte("%PDF-1.7\noriginal")},
		{"账单.xls", "application/vnd.ms-excel", []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}},
		{"账单.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", spreadsheetFixture(t)},
		{"账单.csv", "text/csv", []byte("日期,金额\n2026-10-04,5")},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			databasePath := filepath.Join(t.TempDir(), "sprout.db")
			store, err := openNoteStore(databasePath)
			if err != nil {
				t.Fatal(err)
			}
			handler := newHandler("test-key", store)
			id := testNoteID + ":file"
			response := uploadTestFile(handler, id, fixture.name, fixture.mediaType, fixture.body)
			if response.Code != 201 {
				t.Fatalf("upload: %d %s", response.Code, response.Body.String())
			}
			if repeat := uploadTestFile(handler, id, fixture.name, fixture.mediaType, fixture.body); repeat.Code != 200 {
				t.Fatal(repeat.Body.String())
			}
			if conflict := uploadTestFile(handler, id, "other"+filepath.Ext(fixture.name), fixture.mediaType, fixture.body); conflict.Code != 409 {
				t.Fatal(conflict.Body.String())
			}
			created := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"","files":[%q],"created_at":"2026-10-04T00:00:00Z"}`, testNoteID, id), testCreateOpID)
			if created.Code != 201 {
				t.Fatalf("create: %d %s", created.Code, created.Body.String())
			}
			n := decodeNote(t, created)
			if len(n.Files) != 1 || len(n.FileAttachments) != 1 || n.FileAttachments[0].Name != fixture.name {
				t.Fatalf("metadata: %#v", n)
			}
			if err := store.close(); err != nil {
				t.Fatal(err)
			}
			store, err = openNoteStore(databasePath)
			if err != nil {
				t.Fatal(err)
			}
			defer store.close()
			handler = newHandler("test-key", store)
			downloaded := performRequest(handler, http.MethodGet, filesPath+id, "", "")
			if downloaded.Code != 200 || !bytes.Equal(downloaded.Body.Bytes(), fixture.body) || downloaded.Header().Get("Content-Type") != fixture.mediaType {
				t.Fatal("original bytes did not survive reopen")
			}
			if !strings.Contains(downloaded.Header().Get("Content-Disposition"), "filename") {
				t.Fatal("missing safe file name")
			}
			var key string
			if err := store.database.QueryRow(`SELECT object_key FROM file_objects WHERE file_id=?`, id).Scan(&key); err != nil {
				t.Fatal(err)
			}
			object, err := os.ReadFile(filepath.Join(store.objectsDirectory, key))
			if err != nil || !bytes.Equal(object, fixture.body) {
				t.Fatal("object not on disk")
			}
		})
	}
}

func TestFileValidationAndFailureIsolation(t *testing.T) {
	store := openTestStore(t)
	handler := newHandler("test-key", store)
	id := testNoteID + ":file"
	for _, fixture := range []struct {
		name, mediaType string
		body            []byte
		status          int
	}{
		{"empty.pdf", "application/pdf", nil, 400},
		{"bad.pdf", "application/pdf", []byte("not a pdf"), 400},
		{"bill.zip", "application/zip", []byte("ZIP"), 400},
		{"../bill.pdf", "application/pdf", []byte("%PDF-"), 400},
		{"bill.csv", "text/csv", []byte{'a', 0, ','}, 400},
		{"bill.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", []byte("PK"), 400},
		{"large.pdf", "application/pdf", append([]byte("%PDF-"), make([]byte, maxFileBytes)...), 413},
	} {
		if response := uploadTestFile(handler, id, fixture.name, fixture.mediaType, fixture.body); response.Code != fixture.status {
			t.Fatalf("%s: %d %s", fixture.name, response.Code, response.Body.String())
		}
	}
	boundary := append([]byte("%PDF-"), make([]byte, maxFileBytes-5)...)
	if response := uploadTestFile(handler, id, "boundary.pdf", "application/pdf", boundary); response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	missing := performRequest(handler, http.MethodPost, notesPath, `{"note_id":"missing","content":"","files":["missing:file"],"created_at":"2026-10-04T00:00:00Z"}`, testCreateOpID)
	if missing.Code != 400 {
		t.Fatal(missing.Body.String())
	}
	var count int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial note committed")
	}
	cross := performRequest(handler, http.MethodPost, notesPath, `{"note_id":"other","content":"","files":["missing:file"],"created_at":"2026-10-04T00:00:00Z"}`, testCreateOpID)
	if cross.Code != 400 || !strings.Contains(cross.Body.String(), "invalid_files") {
		t.Fatal(cross.Body.String())
	}
	if _, err := store.objectPath("../outside"); err == nil {
		t.Fatal("unsafe path accepted")
	}
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, filesPath+id, nil))
	if unauthorized.Code != 401 {
		t.Fatal("file was public")
	}
	// An unwritable object location must never insert metadata.
	blocked := filepath.Join(t.TempDir(), "not-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	store.objectsDirectory = blocked
	failure := uploadTestFile(handler, "failure:file", "bill.pdf", "application/pdf", []byte("%PDF-"))
	if failure.Code != 500 {
		t.Fatal(failure.Body.String())
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM file_objects WHERE file_id='failure:file'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed file became valid")
	}
}

func TestLegacyImageMigrationAndBackup(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "legacy.db")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	image := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}
	hash := sha256.Sum256(image)
	if _, err := database.Exec(`CREATE TABLE image_objects(image_id TEXT PRIMARY KEY,media_type TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL);INSERT INTO image_objects VALUES(?,?,?,?)`, testNoteID+":0", "image/png", hex.EncodeToString(hash[:]), image); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	var remaining int
	var key string
	if err := store.database.QueryRow(`SELECT length(bytes),object_key FROM image_objects`).Scan(&remaining, &key); err != nil || remaining != 0 {
		t.Fatal("legacy BLOB still contains original bytes")
	}
	response := performRequest(newHandler("test-key", store), http.MethodGet, objectsPath+testNoteID+":0", "", "")
	if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), image) {
		t.Fatal("migration changed bytes")
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	backup, err := sql.Open("sqlite", databasePath+".before-objects.db")
	if err != nil {
		t.Fatal(err)
	}
	var saved []byte
	if err := backup.QueryRow(`SELECT bytes FROM image_objects`).Scan(&saved); err != nil || !bytes.Equal(saved, image) {
		t.Fatal("backup cannot restore original")
	}
	backup.Close()
	store, err = openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.close()
	var sameKey string
	if err := store.database.QueryRow(`SELECT object_key FROM image_objects`).Scan(&sameKey); err != nil || sameKey != key {
		t.Fatal("reopen changed migrated object")
	}
}

func TestMigrationInterruptionAndRecovery(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "resume.db")
	store, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	image := []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10}
	hash := sha256.Sum256(image)
	if _, err := store.database.Exec(`INSERT INTO image_objects(image_id,media_type,sha256,bytes) VALUES(?,?,?,?)`, "resume:0", "image/png", hex.EncodeToString(hash[:]), image); err != nil {
		t.Fatal(err)
	}
	// Interrupt after file creation, before the SQLite switch. Source BLOB remains.
	key, err := store.writeObject("resume:0", hex.EncodeToString(hash[:]), image)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	var savedKey string
	var remaining int
	if err := reopened.database.QueryRow(`SELECT object_key,length(bytes) FROM image_objects`).Scan(&savedKey, &remaining); err != nil || savedKey != key || remaining != 0 {
		t.Fatal("interrupted migration did not resume")
	}
	if err := reopened.close(); err != nil {
		t.Fatal(err)
	}

	// Failed object write must leave the source image BLOB intact.
	failurePath := filepath.Join(t.TempDir(), "failure.db")
	failed, err := openNoteStore(failurePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failed.database.Exec(`INSERT INTO image_objects(image_id,media_type,sha256,bytes) VALUES(?,?,?,?)`, "failure:0", "image/png", hex.EncodeToString(hash[:]), image); err != nil {
		t.Fatal(err)
	}
	if err := failed.close(); err != nil {
		t.Fatal(err)
	}
	objectDirectory := filepath.Join(filepath.Dir(failurePath), "objects")
	if err := os.Remove(objectDirectory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectDirectory, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	if store, err := openNoteStore(failurePath); err == nil || store != nil {
		t.Fatal("storage failure did not stop migration")
	}
	raw, err := sql.Open("sqlite", failurePath)
	if err != nil {
		t.Fatal(err)
	}
	var source []byte
	if err := raw.QueryRow(`SELECT bytes FROM image_objects`).Scan(&source); err != nil || !bytes.Equal(source, image) {
		t.Fatal("source bytes lost after failed migration")
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(objectDirectory); err != nil {
		t.Fatal(err)
	}
	recovered, err := openNoteStore(failurePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := recovered.close(); err != nil {
		t.Fatal(err)
	}
}

func TestObjectDatabaseFailureAndBackupRestore(t *testing.T) {
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "source.db")
	store, err := openNoteStore(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	handler := newHandler("test-key", store)
	if _, err := store.database.Exec(`CREATE TRIGGER reject_file BEFORE INSERT ON file_objects BEGIN SELECT RAISE(ABORT,'write failed'); END`); err != nil {
		t.Fatal(err)
	}
	response := uploadTestFile(handler, "failure:file", "bill.pdf", "application/pdf", []byte("%PDF-1.7"))
	if response.Code != 500 {
		t.Fatal(response.Body.String())
	}
	var count int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM file_objects`).Scan(&count); err != nil || count != 0 {
		t.Fatal("database failure published an object")
	}
	if _, err := store.database.Exec(`DROP TRIGGER reject_file`); err != nil {
		t.Fatal(err)
	}
	id := testNoteID + ":file"
	original := []byte("%PDF-1.7\nrestore")
	if response := uploadTestFile(handler, id, "bill.pdf", "application/pdf", original); response.Code != 201 {
		t.Fatal(response.Body.String())
	}
	created := performRequest(handler, http.MethodPost, notesPath, fmt.Sprintf(`{"note_id":%q,"content":"","files":[%q],"created_at":"2026-10-04T00:00:00Z"}`, testNoteID, id), testCreateOpID)
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	if err := store.close(); err != nil {
		t.Fatal(err)
	}
	restore := t.TempDir()
	bytes, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	restoredDatabase := filepath.Join(restore, "source.db")
	if err := os.WriteFile(restoredDatabase, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(filepath.Join(restore, "objects"), os.DirFS(filepath.Join(directory, "objects"))); err != nil {
		t.Fatal(err)
	}
	reopened, err := openNoteStore(restoredDatabase)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	var integrity string
	if err := reopened.database.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatal("restored database integrity failure")
	}
	downloaded := performRequest(newHandler("test-key", reopened), http.MethodGet, filesPath+id, "", "")
	if downloaded.Code != 200 || !strings.EqualFold(hex.EncodeToString(sha256Sum(downloaded.Body.Bytes())), hex.EncodeToString(sha256Sum(original))) {
		t.Fatal("restored object differs")
	}
	if note := performRequest(newHandler("test-key", reopened), http.MethodGet, notesPath+"/"+testNoteID, "", ""); note.Code != 200 || len(decodeNote(t, note).FileAttachments) != 1 {
		t.Fatal("restored relation missing")
	}
}

func sha256Sum(body []byte) []byte { sum := sha256.Sum256(body); return sum[:] }
