package main

// REQ-079,082,083,084,085,086: docs/stories/v0.3.0/
import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
)

type syncItem struct {
	NoteID string `json:"note_id"`
	Action string `json:"action"`
	Note   *note  `json:"note,omitempty"`
}
type syncPage struct {
	Phase   string     `json:"phase"`
	Items   []syncItem `json:"items"`
	Receipt string     `json:"receipt"`
	Cursor  string     `json:"cursor"`
	Done    bool       `json:"done"`
}
type backfillRequest struct {
	Tags []string `json:"tags"`
	Done bool     `json:"done"`
}
type tagChangeRequest struct {
	Tags         []string `json:"tags"`
	ExpectedTags []string `json:"expected_tags"`
}
type subscriptionState struct {
	Phase          string                      `json:"phase"`
	Cursor         int64                       `json:"cursor"`
	Cutoff         *int64                      `json:"cutoff"`
	IDs            []string                    `json:"ids"`
	Position       int                         `json:"position"`
	Eligible       []string                    `json:"eligible"`
	BackfillTags   []string                    `json:"backfill_tags"`
	BackfillKey    string                      `json:"backfill_key"`
	Requests       map[string]backfillRequest  `json:"requests"`
	TagRequests    map[string]tagChangeRequest `json:"tag_requests"`
	PendingIDs     []string                    `json:"pending_ids"`
	PendingEnd     int64                       `json:"pending_end"`
	PendingMore    bool                        `json:"pending_more"`
	PendingReceipt string                      `json:"pending_receipt"`
	PendingDigest  string                      `json:"pending_digest"`
	LastReceipt    string                      `json:"last_receipt"`
}
type subscriptionView struct {
	ID       string   `json:"subscription_id"`
	Tags     []string `json:"tags"`
	Cursor   string   `json:"acknowledged_cursor"`
	Phase    string   `json:"phase"`
	Pending  bool     `json:"pending"`
	Eligible []string `json:"eligible_backfill_tags"`
}

type subscriptionInput struct {
	Tags         []string `json:"tags"`
	ExpectedTags []string `json:"expected_tags"`
	Receipt      string   `json:"receipt"`
	CreationKey  string   `json:"creation_key"`
	RequestID    string   `json:"request_id"`
	Limit        int      `json:"limit"`
}

// Reject duplicate, null, oversized and endpoint-inappropriate fields at the boundary.
func decodeSubscriptionInput(w http.ResponseWriter, r *http.Request, allowed ...string) (subscriptionInput, bool) {
	var input subscriptionInput
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		writeAPIError(w, 400, "invalid_request", "body must be a JSON object")
		return input, false
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			writeAPIError(w, 400, "invalid_request", "invalid JSON field")
			return input, false
		}
		name, ok := token.(string)
		if !ok || seen[name] || !slices.Contains(allowed, name) {
			writeAPIError(w, 400, "invalid_request", "unknown or duplicate field")
			return input, false
		}
		seen[name] = true
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil || string(value) == "null" {
			writeAPIError(w, 400, "invalid_request", "field must have a non-null valid value")
			return input, false
		}
		switch name {
		case "tags":
			err = json.Unmarshal(value, &input.Tags)
		case "expected_tags":
			err = json.Unmarshal(value, &input.ExpectedTags)
		case "receipt":
			err = json.Unmarshal(value, &input.Receipt)
		case "creation_key":
			err = json.Unmarshal(value, &input.CreationKey)
		case "request_id":
			err = json.Unmarshal(value, &input.RequestID)
		case "limit":
			err = json.Unmarshal(value, &input.Limit)
			if input.Limit != 50 {
				err = errors.New("limit must be 50")
			}
		}
		if err != nil {
			writeAPIError(w, 400, "invalid_request", "field has an invalid type")
			return input, false
		}
	}
	if _, err := decoder.Token(); err != nil {
		writeAPIError(w, 400, "invalid_request", "invalid JSON object")
		return input, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeAPIError(w, 400, "invalid_request", "body must contain one JSON object within 65536 bytes")
		return input, false
	}
	return input, true
}

type subscriptionFailure struct {
	status        int
	code, message string
}

func (e subscriptionFailure) Error() string { return e.message }
func syncConflict(message string) error     { return subscriptionFailure{409, "conflict", message} }
func syncInvalid(message string) error      { return subscriptionFailure{400, "invalid_request", message} }

var requestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func checkedTags(tags []string) ([]string, error) {
	if len(tags) > 100 {
		return nil, syncInvalid("tags must contain at most 100 entries")
	}
	for _, tag := range tags {
		if len(tag) > 256 {
			return nil, syncInvalid("tag must not exceed 256 bytes")
		}
	}
	normalized, err := normalizeSubscriptionTags(tags)
	if err != nil {
		return nil, syncInvalid(err.Error())
	}
	return normalized, nil
}
func matchesSyncTags(tags, selected []string) bool {
	for _, tag := range tags {
		if slices.Contains(selected, tag) {
			return true
		}
	}
	return false
}

func validateStoredSyncTags(tags []string, allowEmpty bool) error {
	if tags == nil {
		return errors.New("stored tags must be an array")
	}
	if len(tags) == 0 && allowEmpty {
		return nil
	}
	normalized, err := normalizeSubscriptionTags(tags)
	if err != nil || !slices.Equal(normalized, tags) {
		return errors.New("stored tags must be valid, sorted and unique")
	}
	return nil
}
func readActiveTagNotes(ctx context.Context, q rowQueryer, tags []string) ([]string, []string, error) {
	rows, err := q.QueryContext(ctx, `SELECT note_id,content FROM notes WHERE deleted_at IS NULL ORDER BY note_id`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	ids := []string{}
	all := map[string]bool{}
	for rows.Next() {
		var id, content string
		if err := rows.Scan(&id, &content); err != nil {
			return nil, nil, err
		}
		extracted := extractSyncTags(content)
		for _, tag := range extracted {
			all[tag] = true
		}
		if matchesSyncTags(extracted, tags) {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	discovered := []string{}
	for tag := range all {
		discovered = append(discovered, tag)
	}
	slices.Sort(discovered)
	return ids, discovered, nil
}
func maximumChange(ctx context.Context, q rowQueryer) (int64, error) {
	var value int64
	err := q.QueryRowContext(ctx, `SELECT coalesce(max(change_id),0) FROM note_changes`).Scan(&value)
	return value, err
}
func newSubscriptionState(ctx context.Context, tx *sql.Tx, tags []string) (subscriptionState, error) {
	ids, _, err := readActiveTagNotes(ctx, tx, tags)
	if err != nil {
		return subscriptionState{}, err
	}
	cursor, err := maximumChange(ctx, tx)
	return subscriptionState{Phase: "initial", Cursor: cursor, IDs: ids, Eligible: []string{}, Requests: map[string]backfillRequest{}, TagRequests: map[string]tagChangeRequest{}}, err
}
func encodeSyncCursor(s subscriptionState) string {
	encoded, _ := json.Marshal(struct {
		Change int64 `json:"change_id"`
	}{s.Cursor})
	return string(encoded)
}
func viewSubscription(sub workspaceSubscription, s subscriptionState) subscriptionView {
	return subscriptionView{sub.ID, sub.Tags, encodeSyncCursor(s), s.Phase, s.PendingReceipt != "", s.Eligible}
}
func saveSubscriptionState(ctx context.Context, tx *sql.Tx, sub workspaceSubscription, s subscriptionState) error {
	encoded, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO subscription_api_state VALUES(?,?) ON CONFLICT(subscription_id) DO UPDATE SET state=excluded.state`, sub.ID, string(encoded)); err != nil {
		return err
	}
	var pending, receipt, last any
	if s.PendingReceipt != "" {
		pending = fmt.Sprintf("%s:%d:%t", s.Phase, s.PendingEnd, s.PendingMore)
		receipt = s.PendingReceipt
	}
	if s.LastReceipt != "" {
		last = s.LastReceipt
	}
	_, err = tx.ExecContext(ctx, `UPDATE workspace_subscriptions SET acknowledged_cursor=?,pending_cursor=?,pending_receipt=?,last_acknowledged_receipt=? WHERE subscription_id=? AND owner_id=?`, encodeSyncCursor(s), pending, receipt, last, sub.ID, sub.OwnerID)
	return err
}
func readSubscriptionState(ctx context.Context, tx *sql.Tx, sub workspaceSubscription) (subscriptionState, error) {
	var encoded string
	err := tx.QueryRowContext(ctx, `SELECT state FROM subscription_api_state WHERE subscription_id=?`, sub.ID).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		if sub.Progress.AcknowledgedCursor != nil || sub.Progress.PendingCursor != nil || sub.Progress.LastAcknowledgedReceipt != nil {
			return subscriptionState{}, errors.New("legacy subscription progress cannot be reinitialized")
		}
		return newSubscriptionState(ctx, tx, sub.Tags)
	}
	if err != nil {
		return subscriptionState{}, err
	}
	var state subscriptionState
	if err = json.Unmarshal([]byte(encoded), &state); err != nil {
		return state, err
	}
	if state.TagRequests == nil {
		state.TagRequests = map[string]tagChangeRequest{}
	}
	if (state.Phase != "initial" && state.Phase != "incremental" && state.Phase != "backfill") || state.Cursor < 0 || state.Position < 0 || state.Position > len(state.IDs) || state.Requests == nil || state.Eligible == nil || state.PendingEnd < 0 || state.Cutoff != nil && *state.Cutoff < state.Cursor {
		return state, errors.New("stored subscription cursor is invalid")
	}
	maximum, err := maximumChange(ctx, tx)
	if err != nil {
		return state, err
	}
	if state.Cursor > maximum || state.Cutoff != nil && *state.Cutoff > maximum || state.PendingReceipt != "" && (state.Phase == "incremental" && (state.Cutoff == nil || state.PendingEnd < state.Cursor || state.PendingEnd > *state.Cutoff) || state.Phase != "incremental" && (state.PendingEnd < int64(state.Position) || state.PendingEnd > int64(len(state.IDs)))) {
		return state, errors.New("stored subscription watermarks are invalid")
	}
	if !sameOptionalString(sub.Progress.PendingReceipt, optionalReceipt(state.PendingReceipt)) || !sameOptionalString(sub.Progress.LastAcknowledgedReceipt, optionalReceipt(state.LastReceipt)) || sub.Progress.AcknowledgedCursor == nil || *sub.Progress.AcknowledgedCursor != encodeSyncCursor(state) {
		return state, errors.New("stored subscription progress is inconsistent")
	}
	var expectedPending *string
	if state.PendingReceipt != "" {
		value := fmt.Sprintf("%s:%d:%t", state.Phase, state.PendingEnd, state.PendingMore)
		expectedPending = &value
		if !strings.HasPrefix(state.PendingReceipt, state.Phase+":") || state.PendingDigest == "" || len(state.PendingIDs) > 50 || state.PendingIDs == nil {
			return state, errors.New("stored pending page is invalid")
		}
		if state.Phase != "incremental" && (state.PendingEnd != int64(state.Position+len(state.PendingIDs)) || !slices.Equal(state.PendingIDs, state.IDs[state.Position:int(state.PendingEnd)]) || state.PendingMore != (state.PendingEnd < int64(len(state.IDs)))) {
			return state, errors.New("stored full page range is invalid")
		}
		if state.Phase == "incremental" && state.PendingMore != (state.PendingEnd < *state.Cutoff) {
			return state, errors.New("stored incremental range is invalid")
		}
	} else if len(state.PendingIDs) != 0 || state.PendingEnd != 0 || state.PendingMore || state.PendingDigest != "" {
		return state, errors.New("stored pending fields are unpaired")
	}
	if !sameOptionalString(sub.Progress.PendingCursor, expectedPending) {
		return state, errors.New("stored pending cursor is inconsistent")
	}
	if err := validateStoredSyncTags(state.Eligible, true); err != nil {
		return state, err
	}
	for _, tag := range state.Eligible {
		if !slices.Contains(sub.Tags, tag) {
			return state, errors.New("stored backfill eligibility is outside subscription")
		}
	}
	if state.Phase == "incremental" && (len(state.IDs) != 0 || state.Position != 0) || state.Phase != "incremental" && state.Cutoff != nil {
		return state, errors.New("stored phase fields are inconsistent")
	}
	for _, ids := range [][]string{state.IDs, state.PendingIDs} {
		for _, id := range ids {
			if !noteIDPattern.MatchString(id) {
				return state, errors.New("stored subscription note ID is invalid")
			}
		}
	}
	if state.Phase == "backfill" {
		if _, err := checkedTags(state.BackfillTags); err != nil || state.BackfillKey == "" {
			return state, errors.New("stored backfill is invalid")
		}
		request, exists := state.Requests[state.BackfillKey]
		if !exists || request.Done || !slices.Equal(request.Tags, state.BackfillTags) {
			return state, errors.New("stored backfill task is inconsistent")
		}
	}
	return state, nil
}

func optionalReceipt(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (store *noteStore) registerSubscriptionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/tags", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if _, ok := store.authenticateBusiness(w, r, "notes:read"); !ok {
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeAPIError(w, 405, "method_not_allowed", "GET is required")
			return
		}
		_, tags, err := readActiveTagNotes(r.Context(), store.database, nil)
		if err != nil {
			writeAPIError(w, 500, "database_error", "failed to read active tags")
			return
		}
		writeJSON(w, 200, map[string]any{"tags": tags})
	})
	for _, path := range []string{"/api/v1/subscriptions", "/api/v1/subscriptions/"} {
		mux.HandleFunc(path, store.serveSubscription)
	}
}
func (store *noteStore) serveSubscription(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/subscriptions"), "/")
	action := ""
	id := ""
	if len(parts) > 1 {
		id = parts[1]
	}
	if len(parts) > 2 {
		action = parts[2]
	}
	if len(parts) > 3 || len(parts) > 1 && id == "" {
		writeAPIError(w, 404, "not_found", "endpoint does not exist")
		return
	}
	scopes := []string{"subscriptions:manage"}
	if action == "pull" || action == "backfill" {
		scopes = append(scopes, "notes:read")
	}
	owner, ok := store.authenticateBusiness(w, r, scopes...)
	if !ok {
		return
	}
	allowed := "POST"
	if id != "" && action == "" {
		allowed = "GET, PATCH"
	}
	if action != "" && action != "pull" && action != "ack" && action != "backfill" {
		writeAPIError(w, 404, "not_found", "endpoint does not exist")
		return
	}
	if !(r.Method == http.MethodPost && allowed == "POST" || r.Method == http.MethodGet && allowed == "GET, PATCH" || r.Method == http.MethodPatch && allowed == "GET, PATCH") {
		w.Header().Set("Allow", allowed)
		writeAPIError(w, 405, "method_not_allowed", "method is not allowed")
		return
	}
	var input subscriptionInput
	if r.URL.RawQuery != "" {
		writeAPIError(w, 400, "invalid_request", "URL parameters are not supported")
		return
	}
	if r.Method != http.MethodGet {
		fields := []string{}
		switch {
		case r.Method == http.MethodPatch:
			fields = []string{"tags", "expected_tags", "request_id"}
		case id == "":
			fields = []string{"tags", "creation_key"}
		case action == "backfill":
			fields = []string{"tags", "request_id"}
		case action == "ack":
			fields = []string{"receipt"}
		case action == "pull":
			fields = []string{"limit"}
		}
		decoded, valid := decodeSubscriptionInput(w, r, fields...)
		if !valid {
			return
		}
		input = decoded
	}
	tx, err := store.database.BeginTx(r.Context(), nil)
	if err != nil {
		writeAPIError(w, 500, "database_error", "failed to begin subscription transaction")
		return
	}
	defer tx.Rollback()
	status := 200
	var response any
	if id == "" {
		status, response, err = store.createAPISubscription(r, tx, owner, input.Tags, input.CreationKey)
	} else {
		var sub workspaceSubscription
		sub, err = readWorkspaceSubscription(r.Context(), tx, owner, id)
		if errors.Is(err, sql.ErrNoRows) {
			err = subscriptionFailure{404, "not_found", "subscription does not exist"}
		}
		if err == nil {
			var state subscriptionState
			state, err = readSubscriptionState(r.Context(), tx, sub)
			if err == nil {
				switch {
				case r.Method == http.MethodGet:
					response = viewSubscription(sub, state)
				case r.Method == http.MethodPatch:
					err = updateSubscriptionTags(r.Context(), tx, &sub, &state, input.Tags, input.ExpectedTags, input.RequestID)
					response = viewSubscription(sub, state)
				case action == "pull":
					response, err = store.pullSubscription(r.Context(), tx, sub, &state)
				case action == "ack":
					err = ackSubscription(&state, input.Receipt)
					response = viewSubscription(sub, state)
				case action == "backfill":
					err = startSubscriptionBackfill(r, tx, sub, &state, input.Tags, input.RequestID)
					response = viewSubscription(sub, state)
				}
				if err == nil {
					err = saveSubscriptionState(r.Context(), tx, sub, state)
				}
			}
		}
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		var failure subscriptionFailure
		if errors.As(err, &failure) {
			writeAPIError(w, failure.status, failure.code, failure.message)
		} else {
			writeAPIError(w, 500, "database_error", "subscription storage failed")
		}
		return
	}
	writeJSON(w, status, response)
}
func (store *noteStore) createAPISubscription(r *http.Request, tx *sql.Tx, owner string, tags []string, key string) (int, any, error) {
	normalized, err := checkedTags(tags)
	if err != nil {
		return 0, nil, err
	}
	if !requestKeyPattern.MatchString(key) {
		return 0, nil, syncInvalid("valid creation_key is required")
	}
	encoded, _ := json.Marshal(normalized)
	var id, original string
	err = tx.QueryRowContext(r.Context(), `SELECT subscription_id,tags FROM subscription_requests WHERE owner_id=? AND request_key=?`, owner, key).Scan(&id, &original)
	if err == nil {
		if original != string(encoded) {
			return 0, nil, syncConflict("creation_key already used with other tags")
		}
		sub, err := readWorkspaceSubscription(r.Context(), tx, owner, id)
		if err != nil {
			return 0, nil, err
		}
		state, err := readSubscriptionState(r.Context(), tx, sub)
		return 200, viewSubscription(sub, state), err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, nil, err
	}
	id, err = randomOAuthSecret()
	if err != nil {
		return 0, nil, err
	}
	sub := workspaceSubscription{ID: id, OwnerID: owner, Tags: normalized}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO workspace_subscriptions(subscription_id,owner_id,tags) VALUES(?,?,?)`, id, owner, string(encoded)); err != nil {
		return 0, nil, err
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO subscription_requests VALUES(?,?,?,?)`, owner, key, string(encoded), id); err != nil {
		return 0, nil, err
	}
	state, err := newSubscriptionState(r.Context(), tx, normalized)
	if err != nil {
		return 0, nil, err
	}
	err = saveSubscriptionState(r.Context(), tx, sub, state)
	return 201, viewSubscription(sub, state), err
}
func updateSubscriptionTags(ctx context.Context, tx *sql.Tx, sub *workspaceSubscription, state *subscriptionState, tags, expected []string, key string) error {
	selected, err := checkedTags(tags)
	if err != nil {
		return err
	}
	previous, err := checkedTags(expected)
	if err != nil {
		return err
	}
	if !requestKeyPattern.MatchString(key) {
		return syncInvalid("valid request_id is required")
	}
	if request, exists := state.TagRequests[key]; exists {
		if !slices.Equal(request.Tags, selected) || !slices.Equal(request.ExpectedTags, previous) {
			return syncConflict("request_id already used with other tag configuration")
		}
		return nil
	}
	if slices.Equal(sub.Tags, selected) {
		state.TagRequests[key] = tagChangeRequest{selected, previous}
		return nil
	}
	if !slices.Equal(sub.Tags, previous) {
		return syncConflict("expected_tags does not match subscription")
	}
	if state.Phase != "incremental" || state.PendingReceipt != "" || state.Cutoff != nil {
		return syncConflict("subscription must be idle before changing tags")
	}
	eligible := []string{}
	for _, tag := range selected {
		if !slices.Contains(sub.Tags, tag) || slices.Contains(state.Eligible, tag) {
			eligible = append(eligible, tag)
		}
	}
	state.Eligible = eligible
	encoded, _ := json.Marshal(selected)
	if _, err = tx.ExecContext(ctx, `UPDATE workspace_subscriptions SET tags=? WHERE subscription_id=? AND owner_id=?`, string(encoded), sub.ID, sub.OwnerID); err != nil {
		return err
	}
	sub.Tags = selected
	state.TagRequests[key] = tagChangeRequest{selected, previous}
	return nil
}
func startSubscriptionBackfill(r *http.Request, tx *sql.Tx, sub workspaceSubscription, state *subscriptionState, tags []string, key string) error {
	selected, err := checkedTags(tags)
	if err != nil {
		return err
	}
	if !requestKeyPattern.MatchString(key) {
		return syncInvalid("valid request_id is required")
	}
	if previous, exists := state.Requests[key]; exists {
		if !slices.Equal(previous.Tags, selected) {
			return syncConflict("backfill key already used with other tags")
		}
		return nil
	}
	if state.Phase != "incremental" || state.PendingReceipt != "" || state.Cutoff != nil {
		return syncConflict("subscription must be idle before backfill")
	}
	for _, tag := range selected {
		if !slices.Contains(state.Eligible, tag) || !slices.Contains(sub.Tags, tag) {
			return syncInvalid("backfill tag must be newly added and still subscribed")
		}
	}
	ids, _, err := readActiveTagNotes(r.Context(), tx, selected)
	if err != nil {
		return err
	}
	state.IDs = ids
	state.Position = 0
	state.Phase = "backfill"
	state.BackfillTags = selected
	state.BackfillKey = key
	state.Requests[key] = backfillRequest{Tags: selected}
	return nil
}

func scanSubscriptionChanges(ctx context.Context, tx *sql.Tx, sub workspaceSubscription, state *subscriptionState) ([]string, int64, bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT change_id,note_id,tags_before,tags_after FROM note_changes WHERE change_id>? AND change_id<=? ORDER BY change_id LIMIT 500`, state.Cursor, *state.Cutoff)
	if err != nil {
		return nil, 0, false, err
	}
	defer rows.Close()
	ids := []string{}
	end := state.Cursor
	for rows.Next() {
		var change int64
		var id, before, after string
		if err := rows.Scan(&change, &id, &before, &after); err != nil {
			return nil, 0, false, err
		}
		var previous, current []string
		if err := json.Unmarshal([]byte(before), &previous); err != nil {
			return nil, 0, false, err
		}
		if err := json.Unmarshal([]byte(after), &current); err != nil {
			return nil, 0, false, err
		}
		if validateStoredSyncTags(previous, true) != nil || validateStoredSyncTags(current, true) != nil || !noteIDPattern.MatchString(id) {
			return nil, 0, false, errors.New("invalid stored change")
		}
		if matchesSyncTags(previous, sub.Tags) || matchesSyncTags(current, sub.Tags) {
			if !slices.Contains(ids, id) {
				if len(ids) == 50 {
					break
				}
				ids = append(ids, id)
			}
		}
		end = change
	}
	if err := rows.Err(); err != nil {
		return nil, 0, false, err
	}
	rows.Close()
	var remaining int
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM note_changes WHERE change_id>? AND change_id<=?)`, end, *state.Cutoff).Scan(&remaining); err != nil {
		return nil, 0, false, err
	}
	if remaining == 0 {
		end = *state.Cutoff
	}
	return ids, end, remaining != 0, nil
}
func (store *noteStore) pullSubscription(ctx context.Context, tx *sql.Tx, sub workspaceSubscription, state *subscriptionState) (syncPage, error) {
	if state.PendingReceipt == "" {
		if state.Phase == "incremental" {
			if state.Cutoff == nil {
				cutoff, err := maximumChange(ctx, tx)
				if err != nil {
					return syncPage{}, err
				}
				state.Cutoff = &cutoff
			}
			ids, end, more, err := scanSubscriptionChanges(ctx, tx, sub, state)
			if err != nil {
				return syncPage{}, err
			}
			state.PendingIDs = ids
			state.PendingEnd = end
			state.PendingMore = more
		} else {
			end := min(state.Position+50, len(state.IDs))
			state.PendingIDs = append([]string{}, state.IDs[state.Position:end]...)
			state.PendingEnd = int64(end)
			state.PendingMore = end < len(state.IDs)
		}
	}
	items := []syncItem{}
	selected := sub.Tags
	if state.Phase == "backfill" {
		selected = state.BackfillTags
	}
	for _, id := range state.PendingIDs {
		n, err := getNoteWithQuery(ctx, tx, id)
		if errors.Is(err, sql.ErrNoRows) {
			items = append(items, syncItem{NoteID: id, Action: "stop"})
			continue
		}
		if err != nil {
			return syncPage{}, err
		}
		if n.DeletedAt != nil || !matchesSyncTags(extractSyncTags(n.Content), selected) {
			items = append(items, syncItem{NoteID: id, Action: "stop"})
		} else {
			items = append(items, syncItem{NoteID: id, Action: "upsert", Note: &n})
		}
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return syncPage{}, err
	}
	digest := tokenHash(string(encoded))
	if state.PendingReceipt == "" || state.PendingDigest != digest {
		secret, err := randomOAuthSecret()
		if err != nil {
			return syncPage{}, err
		}
		state.PendingReceipt = state.Phase + ":" + secret
		state.PendingDigest = digest
	}
	return syncPage{state.Phase, items, state.PendingReceipt, encodeSyncCursor(*state), !state.PendingMore}, nil
}
func ackSubscription(state *subscriptionState, receipt string) error {
	if receipt == "" {
		return syncInvalid("receipt is required")
	}
	if receipt == state.LastReceipt {
		return nil
	}
	if receipt != state.PendingReceipt {
		return syncConflict("receipt does not match pending page")
	}
	if state.Phase == "incremental" {
		state.Cursor = state.PendingEnd
		if !state.PendingMore {
			state.Cutoff = nil
		}
	} else {
		state.Position = int(state.PendingEnd)
		if !state.PendingMore {
			if state.Phase == "backfill" {
				previous := state.Requests[state.BackfillKey]
				previous.Done = true
				state.Requests[state.BackfillKey] = previous
				remaining := []string{}
				for _, tag := range state.Eligible {
					if !slices.Contains(state.BackfillTags, tag) {
						remaining = append(remaining, tag)
					}
				}
				state.Eligible = remaining
				state.BackfillTags = nil
				state.BackfillKey = ""
			}
			state.Phase = "incremental"
			state.IDs = nil
			state.Position = 0
		}
	}
	state.LastReceipt = receipt
	state.PendingReceipt = ""
	state.PendingDigest = ""
	state.PendingIDs = nil
	state.PendingEnd = 0
	state.PendingMore = false
	return nil
}
