package main

// REQ-038: Real SQLite initialization must not seed or replace user data.
import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDatabaseInitializationStartsEmpty(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "fresh.db")
	for attempt := 0; attempt < 3; attempt++ {
		store, err := openNoteStore(databasePath)
		if err != nil {
			t.Fatal(err)
		}
		for _, table := range []string{"notes", "image_objects", "note_images", "processed_operations"} {
			var count int
			if err := store.database.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("%s has %d seeded rows", table, count)
			}
		}
		handler := newHandler("test-key", store)
		response := performRequest(handler, http.MethodGet, healthPath, "", "")
		if response.Code != http.StatusOK {
			t.Fatalf("empty database health: %d %s", response.Code, response.Body.String())
		}
		response = performRequest(handler, http.MethodGet, notesPath+"/missing-note", "", "")
		if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "note_not_found") {
			t.Fatalf("empty database lookup: %d %s", response.Code, response.Body.String())
		}
		if _, err := store.database.Exec(`INSERT INTO note_images VALUES ('missing', 0, 'missing:0')`); err == nil {
			t.Fatal("foreign key constraint was not enabled")
		}
		if err := store.close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDatabaseInitializationRollsBackPartialSchema(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "incompatible.db")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("CREATE TABLE processed_operations (unexpected TEXT)"); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if store, err := openNoteStore(databasePath); err == nil || store != nil {
		t.Fatal("incompatible schema was accepted")
	}
	database, err = sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	}()
	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('notes','image_objects','note_images')").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("failed initialization left partially created tables")
	}
}

func TestDatabaseInitializationRejectsInvalidPathsAndCorruptFiles(t *testing.T) {
	directory := t.TempDir()
	corrupt := filepath.Join(directory, "corrupt.db")
	if err := os.WriteFile(corrupt, []byte("not a SQLite database"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, databasePath := range []string{"", " ", directory, filepath.Join(directory, "missing", "db.sqlite"), corrupt} {
		if store, err := openNoteStore(databasePath); err == nil || store != nil {
			t.Fatal("invalid database path or content was accepted")
		}
	}
	contents, err := os.ReadFile(corrupt)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "not a SQLite database" {
		t.Fatal("corrupt file was replaced instead of returning an error")
	}
}
