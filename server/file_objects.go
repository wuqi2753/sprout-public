package main

// REQ-042: private object files, backwards-compatible image migration and file API.
import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const filesPath = "/api/v1/files/"
const maxFileBytes = 20 << 20

var fileIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?:file$`)
var objectKeyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var errFileNotFound = errors.New("referenced file not found")

type fileMetadata struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
}

func (store *noteStore) initializeFileObjects(databasePath string) error {
	store.objectsDirectory = filepath.Join(filepath.Dir(databasePath), "objects")
	if err := os.MkdirAll(store.objectsDirectory, 0700); err != nil {
		return fmt.Errorf("create private objects directory: %w", err)
	}
	columns, err := store.database.Query(`PRAGMA table_info(image_objects)`)
	if err != nil {
		return err
	}
	existing := map[string]bool{}
	for columns.Next() {
		var index, notNull, primary int
		var name, kind string
		var defaultValue any
		if err := columns.Scan(&index, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			columns.Close()
			return err
		}
		existing[name] = true
	}
	err = columns.Err()
	columns.Close()
	if err != nil {
		return err
	}
	for _, column := range []struct{ name, definition string }{{"object_key", "TEXT"}, {"size", "INTEGER"}} {
		if !existing[column.name] {
			if _, err := store.database.Exec(`ALTER TABLE image_objects ADD COLUMN ` + column.name + ` ` + column.definition); err != nil {
				return err
			}
		}
	}
	if _, err := store.database.Exec(`
 CREATE TABLE IF NOT EXISTS file_objects (file_id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0 AND size<=20971520), sha256 TEXT NOT NULL, object_key TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS note_files (note_id TEXT NOT NULL REFERENCES notes(note_id), file_id TEXT NOT NULL UNIQUE REFERENCES file_objects(file_id), position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(note_id,position));`); err != nil {
		return err
	}
	// REQ-053: migrate the legacy one-file relation without rewriting object IDs or logs.
	fileColumns, err := store.database.Query("PRAGMA table_info(note_files)")
	if err != nil {
		return err
	}
	hasPosition := false
	for fileColumns.Next() {
		var index, notNull, primary int
		var name, kind string
		var defaultValue any
		if err := fileColumns.Scan(&index, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			fileColumns.Close()
			return err
		}
		if name == "position" {
			hasPosition = true
		}
	}
	err = fileColumns.Err()
	fileColumns.Close()
	if err != nil {
		return err
	}
	if !hasPosition {
		tx, err := store.database.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`ALTER TABLE note_files RENAME TO note_files_single;
 CREATE TABLE note_files (note_id TEXT NOT NULL REFERENCES notes(note_id), file_id TEXT NOT NULL UNIQUE REFERENCES file_objects(file_id), position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(note_id,position));
 INSERT INTO note_files SELECT note_id,file_id,0 FROM note_files_single;
 DROP TABLE note_files_single;`); err != nil {
			return errors.Join(err, tx.Rollback())
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	var pending int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM image_objects WHERE object_key IS NULL`).Scan(&pending); err != nil {
		return err
	}
	if pending == 0 {
		return nil
	}
	// SQLite generates a consistent snapshot including WAL contents before source BLOBs are removed.
	backupPath := databasePath + ".before-objects.db"
	if _, err := os.Stat(backupPath); errors.Is(err, os.ErrNotExist) {
		if _, err := store.database.Exec(`VACUUM INTO '` + strings.ReplaceAll(backupPath, "'", "''") + `'`); err != nil {
			return fmt.Errorf("backup before image migration: %w", err)
		}
	} else if err != nil {
		return err
	}
	backup, err := sql.Open("sqlite", "file:"+filepath.ToSlash(backupPath)+"?mode=ro")
	if err != nil {
		return err
	}
	var integrity string
	verifyErr := backup.QueryRow(`PRAGMA integrity_check`).Scan(&integrity)
	closeErr := backup.Close()
	if verifyErr != nil || closeErr != nil || integrity != "ok" {
		return fmt.Errorf("invalid pre-migration backup: %w", errors.Join(verifyErr, closeErr, errors.New(integrity)))
	}
	for {
		var id, mediaType, hash string
		var body []byte
		err := store.database.QueryRow(`SELECT image_id,media_type,sha256,bytes FROM image_objects WHERE object_key IS NULL LIMIT 1`).Scan(&id, &mediaType, &hash, &body)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		digest := sha256.Sum256(body)
		if !imageIDPattern.MatchString(id) || hex.EncodeToString(digest[:]) != hash || !matchesImageMediaType(mediaType, body) {
			return errors.New("invalid legacy image prevents migration")
		}
		key, err := store.writeObject(id, hash, body)
		if err != nil {
			return fmt.Errorf("migrate image object: %w", err)
		}
		if _, err := store.database.Exec(`UPDATE image_objects SET object_key=?,size=?,bytes=X'' WHERE image_id=? AND object_key IS NULL`, key, len(body), id); err != nil {
			return err
		}
	}
}

func (store *noteStore) objectPath(key string) (string, error) {
	if !objectKeyPattern.MatchString(key) {
		return "", errors.New("invalid private object key")
	}
	return filepath.Join(store.objectsDirectory, key), nil
}

func (store *noteStore) writeObject(id, hash string, body []byte) (key string, writeError error) {
	digest := sha256.Sum256([]byte(id + ":" + hash))
	key = hex.EncodeToString(digest[:])
	destination, err := store.objectPath(key)
	if err != nil {
		return "", err
	}
	if existing, err := os.ReadFile(destination); err == nil {
		if !bytes.Equal(existing, body) {
			return "", errors.New("existing object bytes do not match checksum")
		}
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	temporary, err := os.CreateTemp(store.objectsDirectory, ".upload-")
	if err != nil {
		return "", err
	}
	temporaryName := temporary.Name()
	defer func() {
		if err := os.Remove(temporaryName); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeError = errors.Join(writeError, err)
		}
	}()
	if _, err := temporary.Write(body); err != nil {
		return "", errors.Join(err, temporary.Close())
	}
	if err := temporary.Sync(); err != nil {
		return "", errors.Join(err, temporary.Close())
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temporaryName, destination); err != nil {
		return "", err
	}
	directory, err := os.Open(store.objectsDirectory)
	if err != nil {
		return "", err
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if err := errors.Join(syncErr, closeErr); err != nil {
		return "", err
	}
	return key, nil
}

func (store *noteStore) serveObject(w http.ResponseWriter, r *http.Request, key, mediaType, name string) {
	path, err := store.objectPath(key)
	if err != nil {
		writeAPIError(w, 500, "object_storage_error", "invalid stored object key")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeAPIError(w, 500, "object_storage_error", "stored object could not be read")
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			fmt.Fprintf(os.Stderr, "close object file: %v\n", err)
		}
	}()
	stat, err := file.Stat()
	if err != nil {
		writeAPIError(w, 500, "object_storage_error", "stored object could not be inspected")
		return
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if name != "" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	}
	http.ServeContent(w, r, "", stat.ModTime(), file)
}

func validFileName(name, mediaType string) bool {
	extensions := map[string]string{"application/pdf": ".pdf", "application/vnd.ms-excel": ".xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx", "text/csv": ".csv"}
	extension, ok := extensions[mediaType]
	if !ok || name == "" || len(name) > 1024 || !utf8.ValidString(name) || strings.ContainsAny(name, "/\\") || strings.ToLower(filepath.Ext(name)) != extension {
		return false
	}
	for _, character := range name {
		if character < 32 || character == 127 {
			return false
		}
	}
	return true
}

func validFileBytes(mediaType string, body []byte) bool {
	switch mediaType {
	case "application/pdf":
		return bytes.HasPrefix(body, []byte("%PDF-"))
	case "application/vnd.ms-excel":
		return bytes.HasPrefix(body, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1})
	case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
		archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if err != nil {
			return false
		}
		names := map[string]bool{}
		for _, entry := range archive.File {
			names[entry.Name] = true
		}
		return names["[Content_Types].xml"] && names["xl/workbook.xml"]
	case "text/csv":
		return utf8.Valid(body) && !bytes.ContainsRune(body, 0) && (bytes.ContainsRune(body, ',') || bytes.ContainsRune(body, '\t'))
	}
	return false
}

func (store *noteStore) registerFileRoutes(mux *http.ServeMux, apiKey string) {
	mux.HandleFunc(filesPath, func(w http.ResponseWriter, r *http.Request) {
		if !store.authenticateAttachment(w, r, apiKey, "note_files", "file_id", strings.TrimPrefix(r.URL.Path, filesPath)) {
			return
		}
		id := strings.TrimPrefix(r.URL.Path, filesPath)
		if !fileIDPattern.MatchString(id) {
			writeAPIError(w, 400, "invalid_file", "file ID is invalid")
			return
		}
		switch r.Method {
		case http.MethodPut:
			store.putFile(w, r, id)
		case http.MethodGet:
			metadata, key, err := readFileMetadata(r.Context(), store.database, id)
			if errors.Is(err, sql.ErrNoRows) {
				writeAPIError(w, 404, "file_not_found", "file does not exist")
				return
			}
			if err != nil {
				writeAPIError(w, 500, "database_error", "failed to read file metadata")
				return
			}
			store.serveObject(w, r, key, metadata.MediaType, metadata.Name)
		default:
			w.Header().Set("Allow", "GET, PUT")
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
		}
	})
}

func (store *noteStore) putFile(w http.ResponseWriter, r *http.Request, id string) {
	name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
	mediaType := r.Header.Get("Content-Type")
	if err != nil || !validFileName(name, mediaType) || !objectKeyPattern.MatchString(r.Header.Get("X-File-SHA256")) {
		writeAPIError(w, 400, "invalid_file", "invalid file metadata")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxFileBytes+1))
	if err != nil {
		writeAPIError(w, 400, "invalid_file", "file could not be read")
		return
	}
	if len(body) > maxFileBytes {
		writeAPIError(w, 413, "file_too_large", "file exceeds 20 MiB")
		return
	}
	digest := sha256.Sum256(body)
	hash := hex.EncodeToString(digest[:])
	if len(body) == 0 || hash != r.Header.Get("X-File-SHA256") || !validFileBytes(mediaType, body) {
		writeAPIError(w, 400, "invalid_file", "file bytes do not match declared metadata")
		return
	}
	metadata := fileMetadata{id, name, mediaType, int64(len(body)), hash}
	key, err := store.writeObject(id, hash, body)
	if err != nil {
		writeAPIError(w, 500, "object_storage_error", "file could not be stored")
		return
	}
	result, err := store.database.ExecContext(r.Context(), `INSERT INTO file_objects(file_id,name,media_type,size,sha256,object_key) VALUES(?,?,?,?,?,?) ON CONFLICT(file_id) DO NOTHING`, id, name, mediaType, len(body), hash, key)
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to save file metadata")
		return
	}
	changed, err := result.RowsAffected()
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to confirm file upload")
		return
	}
	if changed == 0 {
		existing, _, err := readFileMetadata(r.Context(), store.database, id)
		if err != nil {
			writeAPIError(w, 500, "database_error", "failed to read file metadata")
			return
		}
		if existing != metadata {
			writeAPIError(w, 409, "file_id_conflict", "file ID already has different contents or metadata")
			return
		}
		writeJSON(w, 200, metadata)
		return
	}
	writeJSON(w, 201, metadata)
}

func readFileMetadata(ctx context.Context, q rowQueryer, id string) (fileMetadata, string, error) {
	var file fileMetadata
	var key string
	err := q.QueryRowContext(ctx, `SELECT file_id,name,media_type,size,sha256,object_key FROM file_objects WHERE file_id=?`, id).Scan(&file.ID, &file.Name, &file.MediaType, &file.Size, &file.SHA256, &key)
	if err == nil && (!fileIDPattern.MatchString(file.ID) || !validFileName(file.Name, file.MediaType) || file.Size <= 0 || file.Size > maxFileBytes || !objectKeyPattern.MatchString(file.SHA256) || !objectKeyPattern.MatchString(key)) {
		err = errors.New("invalid stored file metadata")
	}
	return file, key, err
}

// REQ-053: ID validation also serves legacy reads; write limits are checked separately.
func validNoteFiles(noteID string, files, images []string) bool {
	seen := map[string]bool{}
	for _, id := range files {
		if !fileIDPattern.MatchString(id) || !strings.HasPrefix(id, noteID+":") || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func replaceNoteFiles(ctx context.Context, tx *sql.Tx, noteID string, files []string) error {
	for _, id := range files {
		if _, _, err := readFileMetadata(ctx, tx, id); errors.Is(err, sql.ErrNoRows) {
			return errFileNotFound
		} else if err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM note_files WHERE note_id=?`, noteID); err != nil {
		return err
	}
	for position, id := range files {
		if _, err := tx.ExecContext(ctx, `INSERT INTO note_files(note_id,file_id,position) VALUES(?,?,?)`, noteID, id, position); err != nil {
			return err
		}
	}
	return nil
}

func readNoteFiles(ctx context.Context, q rowQueryer, n *note) error {
	n.Files = []string{}
	n.FileAttachments = []fileMetadata{}
	rows, err := q.QueryContext(ctx, `SELECT file_id FROM note_files WHERE note_id=? ORDER BY position`, n.NoteID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		n.Files = append(n.Files, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range n.Files {
		file, _, err := readFileMetadata(ctx, q, id)
		if err != nil {
			return err
		}
		n.FileAttachments = append(n.FileAttachments, file)
	}
	return nil
}
