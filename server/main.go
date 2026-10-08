package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	defaultListenAddress = ":8080"
	defaultDatabasePath  = "sprout.db"
	healthPath           = "/api/v1/health"
	notesPath            = "/api/v1/notes"
	operationsPath       = "/api/v1/sync/operations/"
	objectsPath          = "/api/v1/objects/"
	maxImageBytes        = 10 << 20
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var noteIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// REQ-048: revisions preserve immutable bytes when editor attachments change.
var imageIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?:[0-8]$`)

type serverConfig struct{ listenAddress, apiKey, databasePath string }
type jsonResponse struct {
	Status string `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}
type apiError struct {
	Error apiErrorBody `json:"error"`
}
type versionConflictError struct {
	Error       apiErrorBody `json:"error"`
	CurrentNote note         `json:"current_note"`
}
type apiErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type note struct {
	NoteID          string         `json:"note_id"`
	Content         string         `json:"content"`
	Images          []string       `json:"images"`
	Files           []string       `json:"files"`
	FileAttachments []fileMetadata `json:"file_attachments"`
	Version         int64          `json:"version"`
	CreatedAt       string         `json:"created_at"`
	UpdatedAt       string         `json:"updated_at"`
	DeletedAt       *string        `json:"deleted_at"`
	ExpiresAt       *string        `json:"expires_at"`
}
type operationStatus struct {
	OperationID   string `json:"operation_id"`
	NoteID        string `json:"note_id"`
	Operation     string `json:"operation"`
	Status        string `json:"status"`
	ResultVersion int64  `json:"result_version"`
	AppliedAt     string `json:"applied_at"`
}
type createNoteRequest struct {
	NoteID    string   `json:"note_id"`
	Content   string   `json:"content"`
	Images    []string `json:"images"`
	Files     []string `json:"files"`
	CreatedAt string   `json:"created_at"`
}
type updateNoteRequest struct {
	// REQ-070: optional recording time correction.
	CreatedAt   *string   `json:"created_at"`
	Content     string    `json:"content"`
	Images      *[]string `json:"images"`
	Files       *[]string `json:"files"`
	BaseVersion int64     `json:"base_version"`
}
type deleteNoteRequest struct {
	BaseVersion int64 `json:"base_version"`
}
type storedOperation struct {
	fingerprint  string
	responseCode int
	responseBody []byte
}
type noteStore struct {
	database         *sql.DB
	now              func() time.Time
	objectsDirectory string
}

func loadConfig(getenv func(string) string) (serverConfig, error) {
	listenAddress := strings.TrimSpace(getenv("SPROUT_LISTEN_ADDRESS"))
	if listenAddress == "" {
		listenAddress = defaultListenAddress
	}
	if !strings.Contains(listenAddress, ":") {
		return serverConfig{}, errors.New("SPROUT_LISTEN_ADDRESS must contain a port")
	}
	apiKey := strings.TrimSpace(getenv("SPROUT_API_KEY"))
	if apiKey == "" {
		return serverConfig{}, errors.New("SPROUT_API_KEY must not be empty")
	}
	databasePath := strings.TrimSpace(getenv("SPROUT_DATABASE_PATH"))
	if databasePath == "" {
		databasePath = defaultDatabasePath
	}
	return serverConfig{listenAddress, apiKey, databasePath}, nil
}

// REQ-038: Initialize schema without seeding or replacing any user data.
func openNoteStore(databasePath string) (store *noteStore, initializationError error) {
	if strings.TrimSpace(databasePath) == "" {
		return nil, errors.New("SQLite database path must not be empty")
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	defer func() {
		if initializationError != nil {
			initializationError = errors.Join(initializationError, database.Close())
		}
	}()
	database.SetMaxOpenConns(1)
	if _, err = database.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`); err != nil {
		return nil, fmt.Errorf("configure SQLite database: %w", err)
	}
	transaction, err := database.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin SQLite schema initialization: %w", err)
	}
	defer func() {
		if rollbackError := transaction.Rollback(); rollbackError != nil && !errors.Is(rollbackError, sql.ErrTxDone) {
			store = nil
			initializationError = errors.Join(initializationError, fmt.Errorf("roll back SQLite initialization: %w", rollbackError))
		}
	}()
	if _, err = transaction.Exec(`
		CREATE TABLE IF NOT EXISTS notes (note_id TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
		CREATE TABLE IF NOT EXISTS image_objects (image_id TEXT PRIMARY KEY, media_type TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL);
		CREATE TABLE IF NOT EXISTS note_images (note_id TEXT NOT NULL, position INTEGER NOT NULL, image_id TEXT NOT NULL, PRIMARY KEY(note_id,position), UNIQUE(note_id,image_id), FOREIGN KEY(note_id) REFERENCES notes(note_id), FOREIGN KEY(image_id) REFERENCES image_objects(image_id));
		CREATE TABLE IF NOT EXISTS processed_operations (operation_id TEXT PRIMARY KEY, note_id TEXT NOT NULL, operation TEXT NOT NULL, request_fingerprint TEXT NOT NULL, response_code INTEGER NOT NULL, response_body BLOB NOT NULL, result_version INTEGER NOT NULL, applied_at TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS processed_operations_note_id_index ON processed_operations(note_id);`); err != nil {
		return nil, fmt.Errorf("initialize SQLite database: %w", err)
	}
	if err = transaction.Commit(); err != nil {
		return nil, fmt.Errorf("commit SQLite schema initialization: %w", err)
	}
	store = &noteStore{database: database, now: time.Now}
	if err := store.initializeFileObjects(databasePath); err != nil {
		return nil, err
	}
	if err := store.initializeTrash(); err != nil {
		return nil, err
	}
	return store, nil
}
func (store *noteStore) close() error { return store.database.Close() }

func newHandler(apiKey string, store *noteStore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeJSON(w, 405, jsonResponse{Error: "method not allowed"})
			return
		}
		if !authenticate(r, apiKey) {
			writeJSON(w, 401, jsonResponse{Error: "invalid API key"})
			return
		}
		writeJSON(w, 200, jsonResponse{Status: "ok"})
	})
	mux.HandleFunc(notesPath, func(w http.ResponseWriter, r *http.Request) {
		if !authenticate(r, apiKey) {
			writeAPIError(w, 401, "invalid_api_key", "API key is missing or invalid")
			return
		}
		if r.Method == http.MethodGet {
			handleListActiveNotes(w, r, store)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
			return
		}
		handleCreateNote(w, r, store)
	})
	mux.HandleFunc(notesPath+"/", func(w http.ResponseWriter, r *http.Request) {
		if !authenticate(r, apiKey) {
			writeAPIError(w, 401, "invalid_api_key", "API key is missing or invalid")
			return
		}
		id := strings.TrimPrefix(r.URL.Path, notesPath+"/")
		if strings.HasSuffix(id, "/restore") {
			id = strings.TrimSuffix(id, "/restore")
			if !noteIDPattern.MatchString(id) || r.Method != http.MethodPost {
				writeAPIError(w, 400, "invalid_request", "restore requires a valid note_id and POST")
				return
			}
			handleRestoreNote(w, r, store, id)
			return
		}
		if strings.HasSuffix(id, "/purge") {
			id = strings.TrimSuffix(id, "/purge")
			if !noteIDPattern.MatchString(id) || r.Method != http.MethodPost {
				writeAPIError(w, 400, "invalid_request", "purge requires a valid note_id and POST")
				return
			}
			handlePurgeNote(w, r, store, id)
			return
		}
		if strings.Contains(id, "/") || !noteIDPattern.MatchString(id) {
			writeAPIError(w, 400, "invalid_note_id", "note_id has an invalid format")
			return
		}
		switch r.Method {
		case http.MethodGet:
			handleGetNote(w, r, store, id)
		case http.MethodPatch:
			handleUpdateNote(w, r, store, id)
		case http.MethodDelete:
			handleDeleteNote(w, r, store, id)
		default:
			w.Header().Set("Allow", "GET, PATCH, DELETE")
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
		}
	})
	store.registerTrashRoutes(mux, apiKey)
	mux.HandleFunc(operationsPath, func(w http.ResponseWriter, r *http.Request) {
		if !authenticate(r, apiKey) {
			writeAPIError(w, 401, "invalid_api_key", "API key is missing or invalid")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
			return
		}
		id := strings.TrimPrefix(r.URL.Path, operationsPath)
		if strings.Contains(id, "/") || !uuidPattern.MatchString(id) {
			writeAPIError(w, 400, "invalid_operation_id", "operation_id must be a UUID")
			return
		}
		handleGetOperation(w, r, store, id)
	})
	mux.HandleFunc(objectsPath, func(w http.ResponseWriter, r *http.Request) {
		if !authenticate(r, apiKey) {
			writeAPIError(w, 401, "invalid_api_key", "API key is missing or invalid")
			return
		}
		id := strings.TrimPrefix(r.URL.Path, objectsPath)
		if !imageIDPattern.MatchString(id) {
			writeAPIError(w, 400, "invalid_image_id", "image_id has an invalid format")
			return
		}
		switch r.Method {
		case http.MethodPut:
			handlePutImage(w, r, store, id)
		case http.MethodGet:
			handleGetImage(w, r, store, id)
		default:
			w.Header().Set("Allow", "GET, PUT")
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
		}
	})
	store.registerFileRoutes(mux, apiKey)
	return mux
}

func handlePutImage(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	mediaType := r.Header.Get("Content-Type")
	if !slices.Contains([]string{"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"}, mediaType) {
		writeAPIError(w, 400, "invalid_media_type", "unsupported image media type")
		return
	}
	bytes, err := io.ReadAll(io.LimitReader(r.Body, maxImageBytes+1))
	if err != nil {
		writeAPIError(w, 400, "invalid_image", "image could not be read")
		return
	}
	if len(bytes) == 0 {
		writeAPIError(w, 400, "invalid_image", "image must not be empty")
		return
	}
	if len(bytes) > maxImageBytes {
		writeAPIError(w, 413, "image_too_large", "image exceeds 10 MiB")
		return
	}
	if !matchesImageMediaType(mediaType, bytes) {
		writeAPIError(w, 400, "invalid_image", "image bytes do not match media type")
		return
	}
	digest := sha256.Sum256(bytes)
	hash := hex.EncodeToString(digest[:])
	objectKey, err := store.writeObject(id, hash, bytes)
	if err != nil {
		writeAPIError(w, 500, "object_storage_error", "failed to save image file")
		return
	}
	result, err := store.database.ExecContext(r.Context(), `INSERT INTO image_objects(image_id,media_type,sha256,bytes,object_key,size) VALUES(?,?,?,X'',?,?) ON CONFLICT(image_id) DO NOTHING`, id, mediaType, hash, objectKey, len(bytes))
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to save image")
		return
	}
	changed, err := result.RowsAffected()
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to confirm image write")
		return
	}
	if changed == 0 {
		var storedType, storedHash string
		if err := store.database.QueryRowContext(r.Context(), `SELECT media_type,sha256 FROM image_objects WHERE image_id=?`, id).Scan(&storedType, &storedHash); err != nil {
			writeAPIError(w, 500, "database_error", "failed to read image")
			return
		}
		if storedType != mediaType || storedHash != hash {
			writeAPIError(w, 409, "image_id_conflict", "image_id already contains different image")
			return
		}
		writeJSON(w, 200, map[string]string{"image_id": id})
		return
	}
	writeJSON(w, 201, map[string]string{"image_id": id})
}

func matchesImageMediaType(mediaType string, body []byte) bool {
	switch mediaType {
	case "image/jpeg":
		return len(body) >= 3 && bytes.Equal(body[:3], []byte{0xff, 0xd8, 0xff})
	case "image/png":
		return len(body) >= 8 && bytes.Equal(body[:8], []byte{0x89, 'P', 'N', 'G', 13, 10, 26, 10})
	case "image/gif":
		return len(body) >= 6 && (string(body[:6]) == "GIF87a" || string(body[:6]) == "GIF89a")
	case "image/webp":
		return len(body) >= 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WEBP"
	case "image/heic", "image/heif":
		return len(body) >= 12 && string(body[4:8]) == "ftyp" && slices.Contains([]string{"heic", "heix", "hevc", "hevx", "mif1", "msf1"}, string(body[8:12]))
	}
	return false
}

func handleGetImage(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	var mediaType string
	var objectKey string
	err := store.database.QueryRowContext(r.Context(), `SELECT media_type,object_key FROM image_objects WHERE image_id=?`, id).Scan(&mediaType, &objectKey)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "image_not_found", "image does not exist")
		return
	}
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to read image")
		return
	}
	store.serveObject(w, r, objectKey, mediaType, "")
}
func authenticate(r *http.Request, key string) bool {
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(key)) == 1
}

func handleCreateNote(w http.ResponseWriter, r *http.Request, store *noteStore) {
	body, input, ok := decodeRequest[createNoteRequest](w, r)
	if !ok {
		return
	}
	input.Content = strings.TrimSpace(input.Content)
	if !noteIDPattern.MatchString(input.NoteID) {
		writeAPIError(w, 400, "invalid_note_id", "note_id has an invalid format")
		return
	}
	if input.Content == "" && len(input.Images) == 0 && len(input.Files) == 0 {
		writeAPIError(w, 400, "invalid_content", "content or images must be present")
		return
	}
	if !validNoteImageIDs(input.NoteID, input.Images) {
		writeAPIError(w, 400, "invalid_images", "images must contain unique valid IDs")
		return
	}
	if len(input.Images)+len(input.Files) > 5 {
		writeAPIError(w, 400, "too_many_attachments", "images and files combined must not exceed 5")
		return
	}
	if !validNoteFiles(input.NoteID, input.Files, input.Images) {
		writeAPIError(w, 400, "invalid_files", "files must contain unique valid IDs belonging to this note")
		return
	}
	createdAt, err := time.Parse(time.RFC3339, input.CreatedAt)
	if err != nil {
		writeAPIError(w, 400, "invalid_created_at", "created_at must be an RFC 3339 timestamp")
		return
	}
	op, ok := requireOperationID(w, r)
	if !ok {
		return
	}
	fingerprint := requestFingerprint(r.Method, r.URL.Path, body)
	code, response, err := store.applyMutation(r.Context(), op, input.NoteID, "create", fingerprint, func(tx *sql.Tx, appliedAt string) (int, []byte, int64, error) {
		stamp := createdAt.UTC().Format(time.RFC3339Nano)
		_, err := tx.ExecContext(r.Context(), `INSERT INTO notes(note_id,content,version,created_at,updated_at) VALUES(?,?,1,?,?)`, input.NoteID, input.Content, stamp, stamp)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") {
				return apiErrorResult(409, "note_already_exists", "note_id already exists")
			}
			return 0, nil, 0, err
		}
		if err := replaceNoteImages(r.Context(), tx, input.NoteID, input.Images); err != nil {
			if errors.Is(err, errImageNotFound) {
				return apiErrorResult(400, "image_not_found", "referenced image has not been uploaded")
			}
			return 0, nil, 0, err
		}
		if err := replaceNoteFiles(r.Context(), tx, input.NoteID, input.Files); err != nil {
			if errors.Is(err, errFileNotFound) {
				return apiErrorResult(400, "file_not_found", "referenced file has not been uploaded")
			}
			return 0, nil, 0, err
		}
		n, err := getNoteWithQuery(r.Context(), tx, input.NoteID)
		if err != nil {
			return 0, nil, 0, err
		}
		return jsonResult(201, n, 1)
	})
	writeMutationResult(w, code, response, err)
}
func handleGetNote(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	n, err := store.getNote(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "note_not_found", "note does not exist")
		return
	}
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to read note")
		return
	}
	writeJSON(w, 200, n)
}

func handleUpdateNote(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	body, input, ok := decodeRequest[updateNoteRequest](w, r)
	if !ok {
		return
	}
	input.Content = strings.TrimSpace(input.Content)
	var recordingTime time.Time
	if input.CreatedAt != nil {
		var parseError error
		recordingTime, parseError = time.Parse(time.RFC3339Nano, *input.CreatedAt)
		if parseError != nil {
			writeAPIError(w, 400, "invalid_created_at", "created_at must be an RFC 3339 timestamp")
			return
		}
	}
	if input.BaseVersion < 1 {
		writeAPIError(w, 400, "invalid_request", "base_version must be positive and content or images must be present")
		return
	}
	if input.Images != nil && !validNoteImageIDs(id, *input.Images) {
		writeAPIError(w, 400, "invalid_images", "images must contain unique valid IDs")
		return
	}
	op, ok := requireOperationID(w, r)
	if !ok {
		return
	}
	code, response, err := store.applyMutation(r.Context(), op, id, "update", requestFingerprint(r.Method, r.URL.Path, body), func(tx *sql.Tx, stamp string) (int, []byte, int64, error) {
		n, err := getNoteWithQuery(r.Context(), tx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return apiErrorResult(404, "note_not_found", "note does not exist")
		}
		if err != nil {
			return 0, nil, 0, err
		}
		if n.DeletedAt != nil {
			return apiErrorResult(409, "note_deleted", "note has been deleted")
		}
		if n.Version != input.BaseVersion {
			return jsonResult(409, versionConflictError{apiErrorBody{"version_conflict", "base_version does not match the current note version"}, n}, 0)
		}
		if input.Images != nil {
			n.Images = nonNilImages(*input.Images)
		}
		if input.Files != nil {
			n.Files = nonNilImages(*input.Files)
		}
		if len(n.Images)+len(n.Files) > 5 {
			return apiErrorResult(400, "too_many_attachments", "images and files combined must not exceed 5")
		}
		if !validNoteFiles(id, n.Files, n.Images) {
			return apiErrorResult(400, "invalid_files", "files must contain unique valid IDs belonging to this note")
		}
		if input.Content == "" && len(n.Images) == 0 && len(n.Files) == 0 {
			return apiErrorResult(400, "invalid_content", "content or images must be present")
		}
		if input.Files != nil {
			if err := replaceNoteFiles(r.Context(), tx, id, n.Files); err != nil {
				if errors.Is(err, errFileNotFound) {
					return apiErrorResult(400, "file_not_found", "referenced file has not been uploaded")
				}
				return 0, nil, 0, err
			}
		}
		if input.Images != nil {
			if err := replaceNoteImages(r.Context(), tx, id, n.Images); err != nil {
				if errors.Is(err, errImageNotFound) {
					return apiErrorResult(400, "image_not_found", "referenced image has not been uploaded")
				}
				return 0, nil, 0, err
			}
		}
		n.Content = input.Content
		if input.CreatedAt != nil {
			n.CreatedAt = recordingTime.UTC().Format(time.RFC3339Nano)
		}
		n.Version++
		n.UpdatedAt = stamp
		if _, err = tx.ExecContext(r.Context(), `UPDATE notes SET content=?,version=?,updated_at=?,created_at=? WHERE note_id=?`, n.Content, n.Version, stamp, n.CreatedAt, id); err != nil {
			return 0, nil, 0, err
		}
		n, err = getNoteWithQuery(r.Context(), tx, id)
		if err != nil {
			return 0, nil, 0, err
		}
		return jsonResult(200, n, n.Version)
	})
	writeMutationResult(w, code, response, err)
}
func handleDeleteNote(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
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
	code, response, err := store.applyMutation(r.Context(), op, id, "delete", requestFingerprint(r.Method, r.URL.Path, body), func(tx *sql.Tx, stamp string) (int, []byte, int64, error) {
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
		if n.DeletedAt != nil {
			return apiErrorResult(409, "note_deleted", "note has already been deleted")
		}
		n.Version++
		n.UpdatedAt = stamp
		n.DeletedAt = &stamp
		expires := mustParseTime(stamp).Add(30 * 24 * time.Hour).Format(time.RFC3339Nano)
		n.ExpiresAt = &expires
		if _, err = tx.ExecContext(r.Context(), `UPDATE notes SET version=?,updated_at=?,deleted_at=?,expires_at=? WHERE note_id=?`, n.Version, stamp, stamp, expires, id); err != nil {
			return 0, nil, 0, err
		}
		return jsonResult(200, n, n.Version)
	})
	writeMutationResult(w, code, response, err)
}
func handleGetOperation(w http.ResponseWriter, r *http.Request, store *noteStore, id string) {
	var s operationStatus
	err := store.database.QueryRowContext(r.Context(), `SELECT operation_id,note_id,operation,'applied',result_version,applied_at FROM processed_operations WHERE operation_id=?`, id).Scan(&s.OperationID, &s.NoteID, &s.Operation, &s.Status, &s.ResultVersion, &s.AppliedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "operation_not_found", "operation does not exist")
		return
	}
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to read operation")
		return
	}
	if !uuidPattern.MatchString(s.OperationID) || !noteIDPattern.MatchString(s.NoteID) || !slices.Contains([]string{"create", "update", "delete", "restore", "purge", "clear"}, s.Operation) || s.Status != "applied" || s.ResultVersion < 1 || !validTimestamp(s.AppliedAt) {
		writeAPIError(w, 500, "database_error", "stored operation has invalid fields")
		return
	}
	writeJSON(w, 200, s)
}

func (store *noteStore) applyMutation(ctx context.Context, op, id, kind, fingerprint string, mutate func(*sql.Tx, string) (int, []byte, int64, error)) (int, []byte, error) {
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	var existing storedOperation
	err = tx.QueryRowContext(ctx, `SELECT request_fingerprint,response_code,response_body FROM processed_operations WHERE operation_id=?`, op).Scan(&existing.fingerprint, &existing.responseCode, &existing.responseBody)
	if err == nil {
		if existing.fingerprint != fingerprint {
			code, body, _, _ := apiErrorResult(409, "idempotency_key_reused", "operation_id was already used for a different request")
			return code, body, nil
		}
		return existing.responseCode, existing.responseBody, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, nil, err
	}
	stamp := store.now().UTC().Format(time.RFC3339Nano)
	code, body, version, err := mutate(tx, stamp)
	if err != nil {
		return 0, nil, err
	}
	if code >= 400 {
		return code, body, nil
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO processed_operations(operation_id,note_id,operation,request_fingerprint,response_code,response_body,result_version,applied_at) VALUES(?,?,?,?,?,?,?,?)`, op, id, kind, fingerprint, code, body, version, stamp); err != nil {
		return 0, nil, err
	}
	if err = tx.Commit(); err != nil {
		return 0, nil, err
	}
	return code, body, nil
}
func (store *noteStore) getNote(ctx context.Context, id string) (note, error) {
	return getNoteWithQuery(ctx, store.database, id)
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func getNoteWithQuery(ctx context.Context, q rowQueryer, id string) (note, error) {
	var n note
	var deleted, expires sql.NullString
	err := q.QueryRowContext(ctx, `SELECT note_id,content,version,created_at,updated_at,deleted_at,expires_at FROM notes WHERE note_id=?`, id).Scan(&n.NoteID, &n.Content, &n.Version, &n.CreatedAt, &n.UpdatedAt, &deleted, &expires)
	if deleted.Valid {
		n.DeletedAt = &deleted.String
	}
	if expires.Valid {
		n.ExpiresAt = &expires.String
	}
	if err != nil {
		return n, err
	}
	rows, err := q.QueryContext(ctx, `SELECT image_id FROM note_images WHERE note_id=? ORDER BY position`, id)
	if err != nil {
		return note{}, err
	}
	n.Images = []string{}
	for rows.Next() {
		var imageID string
		if err := rows.Scan(&imageID); err != nil {
			rows.Close()
			return note{}, err
		}
		n.Images = append(n.Images, imageID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return note{}, err
	}
	if err := readNoteFiles(ctx, q, &n); err != nil {
		return note{}, err
	}
	if !noteIDPattern.MatchString(n.NoteID) || (strings.TrimSpace(n.Content) == "" && len(n.Images) == 0 && len(n.Files) == 0) || !validNoteFiles(n.NoteID, n.Files, n.Images) || !validNoteImageIDs(n.NoteID, n.Images) || n.Version < 1 || !validTimestamp(n.CreatedAt) || !validTimestamp(n.UpdatedAt) || (n.DeletedAt != nil && !validTimestamp(*n.DeletedAt)) || (n.ExpiresAt != nil && !validTimestamp(*n.ExpiresAt)) {
		return note{}, errors.New("stored note has invalid fields")
	}
	return n, nil
}

var errImageNotFound = errors.New("referenced image not found")

func nonNilImages(images []string) []string {
	if images == nil {
		return []string{}
	}
	return images
}
func validImageIDs(images []string) bool {
	if len(images) > 9 {
		return false
	}
	seen := map[string]bool{}
	for _, id := range images {
		if !imageIDPattern.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
func validNoteImageIDs(noteID string, images []string) bool {
	if !validImageIDs(images) {
		return false
	}
	for _, imageID := range images {
		if !strings.HasPrefix(imageID, noteID+":") {
			return false
		}
	}
	return true
}
func replaceNoteImages(ctx context.Context, tx *sql.Tx, noteID string, images []string) error {
	for _, id := range images {
		var exists int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM image_objects WHERE image_id=?`, id).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return errImageNotFound
		}
		if err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM note_images WHERE note_id=?`, noteID); err != nil {
		return err
	}
	for position, id := range images {
		if _, err := tx.ExecContext(ctx, `INSERT INTO note_images(note_id,position,image_id) VALUES(?,?,?)`, noteID, position, id); err != nil {
			return err
		}
	}
	return nil
}
func validTimestamp(value string) bool {
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}
func decodeRequest[T any](w http.ResponseWriter, r *http.Request) ([]byte, T, bool) {
	var value T
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeAPIError(w, 400, "invalid_json", "request body could not be read")
		return nil, value, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&value); err != nil {
		writeAPIError(w, 400, "invalid_json", "request body must be valid JSON with known fields")
		return nil, value, false
	}
	if err = decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeAPIError(w, 400, "invalid_json", "request body must contain exactly one JSON value")
		return nil, value, false
	}
	return body, value, true
}
func requireOperationID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.Header.Get("Idempotency-Key")
	if !uuidPattern.MatchString(id) {
		writeAPIError(w, 400, "invalid_operation_id", "Idempotency-Key must be a UUID")
		return "", false
	}
	return id, true
}
func requestFingerprint(method, path string, body []byte) string {
	digest := sha256.Sum256(append([]byte(method+"\n"+path+"\n"), body...))
	return hex.EncodeToString(digest[:])
}
func jsonResult(code int, response any, version int64) (int, []byte, int64, error) {
	body, err := json.Marshal(response)
	return code, body, version, err
}
func apiErrorResult(code int, errorCode, message string) (int, []byte, int64, error) {
	return jsonResult(code, apiError{apiErrorBody{errorCode, message}}, 0)
}
func writeMutationResult(w http.ResponseWriter, code int, body []byte, err error) {
	if err != nil {
		log.Printf("apply note mutation: %v", err)
		writeAPIError(w, 500, "database_error", "failed to persist note mutation")
		return
	}
	writeRawJSON(w, code, body)
}
func writeAPIError(w http.ResponseWriter, code int, errorCode, message string) {
	writeJSON(w, code, apiError{apiErrorBody{errorCode, message}})
}
func writeJSON(w http.ResponseWriter, code int, response any) {
	body, err := json.Marshal(response)
	if err != nil {
		http.Error(w, "internal server error", 500)
		return
	}
	writeRawJSON(w, code, append(body, '\n'))
}
func writeRawJSON(w http.ResponseWriter, code int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	if _, err := w.Write(body); err != nil {
		log.Printf("write response: %v", err)
	}
}

func run() error {
	configPath := flag.String("env-file", ".env", "Server configuration file path (REQ-032)")
	flag.Parse()
	explicitPath := false
	flag.Visit(func(argument *flag.Flag) {
		if argument.Name == "env-file" {
			explicitPath = true
		}
	})
	if flag.NArg() != 0 {
		return errors.New("unexpected Server arguments; use -env-file to specify configuration")
	}
	config, err := loadConfigFile(*configPath, explicitPath, os.LookupEnv)
	if err != nil {
		return err
	}
	store, err := openNoteStore(config.databasePath)
	if err != nil {
		return err
	}
	defer store.close()
	server := &http.Server{Addr: config.listenAddress, Handler: newHandler(config.apiKey, store), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("sprout server listening on %s", config.listenAddress)
	return fmt.Errorf("serve HTTP: %w", server.ListenAndServe())
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
