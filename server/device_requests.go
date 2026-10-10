package main

// REQ-075: docs/stories/v0.5.0/REQ-075-device-request-approval.md
import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const deviceRequestsPath = "/oauth/device_requests/"

var userCodePattern = regexp.MustCompile(`^[A-Z0-9]{4}-[A-Z0-9]{4}$`)

type deviceRequest struct {
	UserCode  string `json:"user_code"`
	ClientID  string `json:"client_id"`
	Scope     string `json:"scope"`
	ExpiresAt string `json:"expires_at"`
	Status    string `json:"status"`
}

func (store *noteStore) initializeDeviceRequests() error {
	_, err := store.database.Exec(`CREATE TABLE IF NOT EXISTS oauth_device_requests (
 user_code TEXT PRIMARY KEY,
 client_id TEXT NOT NULL CHECK(length(client_id)>0),
 scope TEXT NOT NULL CHECK(length(scope)>0),
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed')),
 decided_at INTEGER
 )`)
	return err
}

func (store *noteStore) registerDeviceRequestRoutes(mux *http.ServeMux, apiKey string) {
	mux.HandleFunc(deviceRequestsPath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !authenticate(r, apiKey) {
			writeAPIError(w, 401, "invalid_api_key", "API key is missing or invalid")
			return
		}
		code := strings.TrimPrefix(r.URL.Path, deviceRequestsPath)
		decisionRoute := strings.HasSuffix(code, "/decision")
		if decisionRoute {
			code = strings.TrimSuffix(code, "/decision")
		}
		if !userCodePattern.MatchString(code) {
			writeAPIError(w, 400, "invalid_user_code", "user_code must match XXXX-XXXX using uppercase letters or digits")
			return
		}
		method := http.MethodGet
		if decisionRoute {
			method = http.MethodPost
		}
		if r.Method != method {
			w.Header().Set("Allow", method)
			writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
			return
		}
		decision := ""
		if decisionRoute {
			var approval struct {
				Decision string `json:"decision"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&approval); err != nil {
				writeAPIError(w, 400, "invalid_decision", "body must contain only decision approve or deny and be at most 1024 bytes")
				return
			}
			if err := decoder.Decode(new(any)); err != io.EOF {
				writeAPIError(w, 400, "invalid_decision", "body must contain one JSON object")
				return
			}
			switch approval.Decision {
			case "approve":
				decision = "approved"
			case "deny":
				decision = "denied"
			default:
				writeAPIError(w, 400, "invalid_decision", "decision must be approve or deny")
				return
			}
		}
		transaction, err := store.database.BeginTx(r.Context(), nil)
		if err != nil {
			writeAPIError(w, 500, "database_error", "failed to begin device request transaction")
			return
		}
		// Always terminate the transaction before returning a response.
		request := deviceRequest{}
		var expiresAt int64
		now := store.now().Unix()
		if decision != "" {
			_, err = transaction.ExecContext(r.Context(), `UPDATE oauth_device_requests SET status=?, decided_at=? WHERE user_code=? AND status='pending' AND expires_at>?`, decision, now, code, now)
		}
		if err == nil {
			err = transaction.QueryRowContext(r.Context(), `SELECT user_code,client_id,scope,expires_at,status FROM oauth_device_requests WHERE user_code=?`, code).Scan(&request.UserCode, &request.ClientID, &request.Scope, &expiresAt, &request.Status)
		}
		if err != nil {
			rollbackErr := transaction.Rollback()
			if rollbackErr != nil {
				writeAPIError(w, 500, "database_error", "failed to roll back device request transaction")
				return
			}
			if errors.Is(err, sql.ErrNoRows) {
				writeAPIError(w, 404, "device_request_not_found", "device request does not exist")
				return
			}
			writeAPIError(w, 500, "database_error", "failed to read or decide device request")
			return
		}
		validStatus := request.Status == "pending" || request.Status == "approved" || request.Status == "denied" || request.Status == "consumed"
		if !validStatus || request.ClientID == "" || request.Scope == "" || expiresAt <= 0 {
			rollbackErr := transaction.Rollback()
			message := "stored device request fields are invalid"
			if rollbackErr != nil {
				message = "failed to roll back invalid device request"
			}
			writeAPIError(w, 500, "database_error", message)
			return
		}
		if err := transaction.Commit(); err != nil {
			writeAPIError(w, 500, "database_error", "failed to commit device request transaction")
			return
		}
		request.ExpiresAt = time.Unix(expiresAt, 0).UTC().Format(time.RFC3339)
		if now >= expiresAt && (request.Status == "pending" || request.Status == "approved") {
			request.Status = "expired"
		}
		if decision != "" && request.Status == "expired" {
			writeAPIError(w, 410, "expired_token", "device request has expired")
			return
		}
		if decision != "" && request.Status != decision {
			writeAPIError(w, 409, "decision_conflict", "device request already has a final result")
			return
		}
		writeJSON(w, 200, request)
	})
}
