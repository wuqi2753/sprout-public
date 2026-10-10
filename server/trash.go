package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const trashPath = "/api/v1/trash"

type trashList struct {
	Notes []note `json:"notes"`
}

type noteList struct {
	Notes []note `json:"notes"`
}

type clearTrashResult struct {
	Purged  int `json:"purged"`
	Version int `json:"version"`
}

func (store *noteStore) initializeTrash() error {
	columns, err := store.database.Query(`PRAGMA table_info(notes)`)
	if err != nil {
		return err
	}
	hasExpiry := false
	for columns.Next() {
		var index, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := columns.Scan(&index, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			columns.Close()
			return err
		}
		if name == "expires_at" {
			hasExpiry = true
		}
	}
	err = columns.Err()
	columns.Close()
	if err != nil {
		return err
	}
	if !hasExpiry {
		if _, err := store.database.Exec(`ALTER TABLE notes ADD COLUMN expires_at TEXT`); err != nil {
			return err
		}
	}
	// Existing tombstones start at their original deletion time, never at migration time.
	_, err = store.database.Exec(`UPDATE notes SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+30 days') WHERE deleted_at IS NOT NULL AND expires_at IS NULL`)
	if err != nil {
		return err
	}
	if _, err := store.database.Exec(`CREATE TABLE IF NOT EXISTS trash_object_cleanup (object_key TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	return store.cleanPendingObjectFiles()
}

func (store *noteStore) registerTrashRoutes(mux *http.ServeMux, apiKey string) {
	mux.HandleFunc(trashPath, func(w http.ResponseWriter, r *http.Request) {
		if !authenticate(r, apiKey) {
			writeAPIError(w, 401, "invalid_api_key", "API key is missing or invalid")
			return
		}
		switch r.Method {
		case http.MethodGet:
			handleListTrash(w, r, store)
		case http.MethodPost:
			handleClearTrash(w, r, store)
		default:
			w.Header().Set("Allow", "GET, POST")
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
		}
	})
}

func listNotes(ctx context.Context, store *noteStore, deleted bool) ([]note, error) {
	query := `SELECT note_id FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC, note_id DESC`
	if deleted {
		query = `SELECT note_id FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, note_id DESC`
	}
	var rows *sql.Rows
	var err error
	rows, err = store.database.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	notes := make([]note, 0, len(ids))
	for _, id := range ids {
		n, err := store.getNote(ctx, id)
		if err != nil {
			return nil, err
		}
		if !deleted || (n.ExpiresAt != nil && store.now().UTC().Before(mustParseTime(*n.ExpiresAt))) {
			notes = append(notes, n)
		}
	}
	return notes, nil
}

func handleListTrash(w http.ResponseWriter, r *http.Request, store *noteStore) {
	if err := store.purgeExpiredNotes(r.Context()); err != nil {
		writeAPIError(w, 500, "database_error", "failed to clean expired notes")
		return
	}
	notes, err := listNotes(r.Context(), store, true)
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to list trash")
		return
	}
	writeJSON(w, 200, trashList{Notes: notes})
}

func handleListActiveNotes(w http.ResponseWriter, r *http.Request, store *noteStore) {
	notes, err := listNotes(r.Context(), store, false)
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to list notes")
		return
	}
	writeJSON(w, 200, noteList{Notes: notes})
}

func handleRestoreNote(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	body, input, ok := decodeRequest[deleteNoteRequest](w, r)
	if !ok {
		return
	}
	if input.BaseVersion < 1 {
		writeAPIError(w, 400, "invalid_request", "base_version must be positive")
		return
	}
	op, ok := requireOperationID(w, r)
	if !ok {
		return
	}
	code, response, err := store.applyMutation(r.Context(), op, id, "restore", requestFingerprint(r.Method, r.URL.Path, body), func(tx *sql.Tx, stamp string) (int, []byte, int64, error) {
		n, err := getNoteWithQuery(r.Context(), tx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return apiErrorResult(404, "note_not_found", "note does not exist")
		}
		if err != nil {
			return 0, nil, 0, err
		}
		if n.Version != input.BaseVersion {
			return jsonResult(409, versionConflictError{apiErrorBody{"version_conflict", "base_version does not match the current note version"}, n}, 0)
		}
		if n.DeletedAt == nil {
			return apiErrorResult(409, "note_not_deleted", "note is not in trash")
		}
		if n.ExpiresAt == nil || !store.now().UTC().Before(mustParseTime(*n.ExpiresAt)) {
			return apiErrorResult(410, "note_expired", "note can no longer be restored")
		}
		n.Version++
		n.UpdatedAt = stamp
		n.DeletedAt = nil
		n.ExpiresAt = nil
		if _, err := tx.ExecContext(r.Context(), `UPDATE notes SET version=?,updated_at=?,deleted_at=NULL,expires_at=NULL WHERE note_id=?`, n.Version, stamp, id); err != nil {
			return 0, nil, 0, err
		}
		return jsonResult(200, n, n.Version)
	})
	writeMutationResult(w, code, response, err)
}

func mustParseTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(fmt.Sprintf("invalid stored expiry: %s", value))
	}
	return parsed
}

func deleteNoteRecords(ctx context.Context, tx *sql.Tx, id, stamp string) error {
	if err := appendPhysicalDeletion(ctx, tx, id, stamp); err != nil {
		return err
	}
	for _, table := range []string{"note_images", "note_files"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE note_id=?`, id); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM notes WHERE note_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO trash_object_cleanup SELECT object_key FROM image_objects WHERE substr(image_id,1,length(?)+1)=?||':' AND image_id NOT IN (SELECT image_id FROM note_images)`, id, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO trash_object_cleanup SELECT object_key FROM file_objects WHERE substr(file_id,1,length(?)+1)=?||':' AND file_id NOT IN (SELECT file_id FROM note_files)`, id, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM image_objects WHERE substr(image_id,1,length(?)+1)=?||':' AND image_id NOT IN (SELECT image_id FROM note_images)`, id, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM file_objects WHERE substr(file_id,1,length(?)+1)=?||':' AND file_id NOT IN (SELECT file_id FROM note_files)`, id, id)
	return err
}

func handlePurgeNote(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	body, input, ok := decodeRequest[deleteNoteRequest](w, r)
	if !ok {
		return
	}
	if input.BaseVersion < 1 {
		writeAPIError(w, 400, "invalid_request", "base_version must be positive")
		return
	}
	op, ok := requireOperationID(w, r)
	if !ok {
		return
	}
	code, response, err := store.applyMutation(r.Context(), op, id, "purge", requestFingerprint(r.Method, r.URL.Path, body), func(tx *sql.Tx, stamp string) (int, []byte, int64, error) {
		n, err := getNoteWithQuery(r.Context(), tx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return apiErrorResult(404, "note_not_found", "note does not exist")
		}
		if err != nil {
			return 0, nil, 0, err
		}
		if n.Version != input.BaseVersion {
			return jsonResult(409, versionConflictError{apiErrorBody{"version_conflict", "base_version does not match the current note version"}, n}, 0)
		}
		if err := deleteNoteRecords(r.Context(), tx, id, stamp); err != nil {
			return 0, nil, 0, err
		}
		return jsonResult(200, n, n.Version)
	})
	if err == nil && code == 200 {
		err = store.cleanPendingObjectFiles()
	}
	writeMutationResult(w, code, response, err)
}

func handleClearTrash(w http.ResponseWriter, r *http.Request, store *noteStore) {
	body, _, ok := decodeRequest[struct{}](w, r)
	if !ok {
		return
	}
	op, ok := requireOperationID(w, r)
	if !ok {
		return
	}
	code, response, err := store.applyMutation(r.Context(), op, "trash", "clear", requestFingerprint(r.Method, r.URL.Path, body), func(tx *sql.Tx, stamp string) (int, []byte, int64, error) {
		rows, err := tx.QueryContext(r.Context(), `SELECT note_id FROM notes WHERE deleted_at IS NOT NULL`)
		if err != nil {
			return 0, nil, 0, err
		}
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return 0, nil, 0, err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return 0, nil, 0, err
		}
		for _, id := range ids {
			if err := deleteNoteRecords(r.Context(), tx, id, stamp); err != nil {
				return 0, nil, 0, err
			}
		}
		return jsonResult(200, clearTrashResult{Purged: len(ids), Version: 1}, 1)
	})
	if err == nil && code == 200 {
		err = store.cleanPendingObjectFiles()
	}
	writeMutationResult(w, code, response, err)
}

func (store *noteStore) purgeExpiredNotes(ctx context.Context) error {
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT note_id,expires_at FROM notes WHERE deleted_at IS NOT NULL`)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		var expiry sql.NullString
		if err := rows.Scan(&id, &expiry); err != nil {
			rows.Close()
			return err
		}
		if !expiry.Valid {
			rows.Close()
			return fmt.Errorf("deleted note %s has no expiry", id)
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, expiry.String)
		if err != nil {
			rows.Close()
			return fmt.Errorf("deleted note %s has invalid expiry: %w", id, err)
		}
		if !store.now().UTC().Before(expiresAt) {
			ids = append(ids, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := deleteNoteRecords(ctx, tx, id, store.now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if len(ids) > 0 {
		return store.cleanPendingObjectFiles()
	}
	return nil
}

func (store *noteStore) cleanPendingObjectFiles() error {
	rows, err := store.database.Query(`SELECT object_key FROM trash_object_cleanup`)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, key := range keys {
		if !objectKeyPattern.MatchString(key) {
			return fmt.Errorf("invalid queued object key: %s", key)
		}
		if err := os.Remove(filepath.Join(store.objectsDirectory, key)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove expired object %s: %w", key, err)
		}
		if _, err := store.database.Exec(`DELETE FROM trash_object_cleanup WHERE object_key=?`, key); err != nil {
			return err
		}
	}
	return nil
}
