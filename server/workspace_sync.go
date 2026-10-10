package main

// REQ-078: docs/stories/v0.3.0/REQ-078-workspace-sync-tables.md
import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
)

const workspaceSyncSchema = `
CREATE TABLE IF NOT EXISTS note_changes (
 change_id INTEGER PRIMARY KEY AUTOINCREMENT,
 note_id TEXT NOT NULL CHECK(length(note_id)>0),
 note_version INTEGER NOT NULL CHECK(note_version>0),
 tags_before TEXT NOT NULL CHECK(json_valid(tags_before) AND json_type(tags_before)='array'),
 tags_after TEXT NOT NULL CHECK(json_valid(tags_after) AND json_type(tags_after)='array'),
 changed_at TEXT NOT NULL CHECK(length(changed_at)>0)
);
CREATE TABLE IF NOT EXISTS workspace_subscriptions (
 subscription_id TEXT PRIMARY KEY NOT NULL CHECK(length(subscription_id)>0),
 owner_id TEXT NOT NULL CHECK(length(owner_id)>0),
 tags TEXT NOT NULL CHECK(json_valid(tags) AND json_type(tags)='array' AND json_array_length(tags)>0),
 acknowledged_cursor TEXT CHECK(acknowledged_cursor IS NULL OR length(acknowledged_cursor)>0),
 pending_cursor TEXT CHECK(pending_cursor IS NULL OR length(pending_cursor)>0),
 pending_receipt TEXT CHECK(pending_receipt IS NULL OR length(pending_receipt)>0),
 last_acknowledged_receipt TEXT CHECK(last_acknowledged_receipt IS NULL OR length(last_acknowledged_receipt)>0),
 CHECK((pending_cursor IS NULL)=(pending_receipt IS NULL))
);
CREATE TRIGGER IF NOT EXISTS workspace_subscription_identity_fixed
BEFORE UPDATE OF subscription_id,owner_id,tags ON workspace_subscriptions
WHEN NEW.subscription_id IS NOT OLD.subscription_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.tags IS NOT OLD.tags
BEGIN SELECT RAISE(ABORT,'subscription identity and tags are fixed'); END;
`

// ECMAScript whitespace includes BOM but excludes Unicode NEL.
func tagWhitespace(r rune) bool { return r == '\uFEFF' || (r != '\u0085' && unicode.IsSpace(r)) }

func normalizeSubscriptionTags(tags []string) ([]string, error) {
	if len(tags) == 0 {
		return nil, errors.New("subscription tags must not be empty")
	}
	unique := make(map[string]bool)
	for _, tag := range tags {
		if tag == "" || strings.ContainsRune(tag, '#') || strings.IndexFunc(tag, tagWhitespace) >= 0 {
			return nil, errors.New("subscription tag must be nonempty and contain no whitespace or #")
		}
		unique[tag] = true
	}
	normalized := make([]string, 0, len(unique))
	for tag := range unique {
		normalized = append(normalized, tag)
	}
	sort.Strings(normalized)
	return normalized, nil
}

func extractSyncTags(content string) []string {
	tags := []string{}
	runes := []rune(content)
	for i := 0; i < len(runes); i++ {
		if runes[i] != '#' {
			continue
		}
		start := i + 1
		end := start
		for end < len(runes) && runes[end] != '#' && !tagWhitespace(runes[end]) {
			end++
		}
		if end > start {
			tags = append(tags, string(runes[start:end]))
		}
		i = end - 1
	}
	if len(tags) == 0 {
		return []string{}
	}
	unique := make(map[string]bool)
	for _, tag := range tags {
		unique[tag] = true
	}
	normalized := make([]string, 0, len(unique))
	for tag := range unique {
		normalized = append(normalized, tag)
	}
	sort.Strings(normalized)
	return normalized
}

type noteChangeState struct {
	version int64
	tags    []string
}

type storedNoteChange struct {
	ID         int64
	NoteID     string
	Version    int64
	TagsBefore []string
	TagsAfter  []string
	ChangedAt  string
}

func (store *noteStore) getNoteChange(ctx context.Context, id int64) (storedNoteChange, error) {
	if id < 1 {
		return storedNoteChange{}, errors.New("change_id must be positive")
	}
	var change storedNoteChange
	var beforeJSON, afterJSON string
	err := store.database.QueryRowContext(ctx, `SELECT change_id,note_id,note_version,tags_before,tags_after,changed_at FROM note_changes WHERE change_id=?`, id).Scan(&change.ID, &change.NoteID, &change.Version, &beforeJSON, &afterJSON, &change.ChangedAt)
	if err != nil {
		return storedNoteChange{}, err
	}
	if !noteIDPattern.MatchString(change.NoteID) || change.Version < 1 || !validTimestamp(change.ChangedAt) || !strings.HasSuffix(change.ChangedAt, "Z") {
		return storedNoteChange{}, errors.New("stored note change has invalid ID, version or UTC time")
	}
	for _, field := range []struct {
		encoded string
		target  *[]string
	}{{beforeJSON, &change.TagsBefore}, {afterJSON, &change.TagsAfter}} {
		if err := json.Unmarshal([]byte(field.encoded), field.target); err != nil || *field.target == nil {
			return storedNoteChange{}, errors.New("stored change tags must be a JSON string array")
		}
		if len(*field.target) == 0 {
			continue
		}
		normalized, err := normalizeSubscriptionTags(*field.target)
		if err != nil {
			return storedNoteChange{}, err
		}
		if len(normalized) != len(*field.target) {
			return storedNoteChange{}, errors.New("stored change tags contain duplicates")
		}
		for i, tag := range normalized {
			if tag != (*field.target)[i] {
				return storedNoteChange{}, errors.New("stored change tags are not normalized")
			}
		}
	}
	return change, nil
}

func readNoteChangeState(ctx context.Context, tx *sql.Tx, id string) (noteChangeState, error) {
	var content string
	var version int64
	var deleted sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT content,version,deleted_at FROM notes WHERE note_id=?`, id).Scan(&content, &version, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return noteChangeState{tags: []string{}}, nil
	}
	if err != nil {
		return noteChangeState{}, err
	}
	if version < 1 {
		return noteChangeState{}, errors.New("stored note version must be positive")
	}
	if deleted.Valid {
		if !validTimestamp(deleted.String) {
			return noteChangeState{}, errors.New("stored deleted_at is invalid")
		}
		return noteChangeState{version: version, tags: []string{}}, nil
	}
	return noteChangeState{version: version, tags: extractSyncTags(content)}, nil
}

func appendNoteChange(ctx context.Context, tx *sql.Tx, id string, before, after noteChangeState, stamp string) error {
	if !noteIDPattern.MatchString(id) || after.version < 1 || !validTimestamp(stamp) || !strings.HasSuffix(stamp, "Z") {
		return errors.New("note change has invalid ID, version or UTC time")
	}
	beforeJSON, err := json.Marshal(before.tags)
	if err != nil {
		return err
	}
	afterJSON, err := json.Marshal(after.tags)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO note_changes(note_id,note_version,tags_before,tags_after,changed_at) VALUES(?,?,?,?,?)`, id, after.version, string(beforeJSON), string(afterJSON), stamp)
	return err
}

func appendPhysicalDeletion(ctx context.Context, tx *sql.Tx, id, stamp string) error {
	before, err := readNoteChangeState(ctx, tx, id)
	if err != nil {
		return err
	}
	if before.version == 0 {
		return nil
	}
	if before.version == math.MaxInt64 {
		return errors.New("note version cannot increment for physical deletion")
	}
	return appendNoteChange(ctx, tx, id, before, noteChangeState{version: before.version + 1, tags: []string{}}, stamp)
}

type subscriptionProgress struct {
	AcknowledgedCursor      *string
	PendingCursor           *string
	PendingReceipt          *string
	LastAcknowledgedReceipt *string
}
type workspaceSubscription struct {
	ID       string
	OwnerID  string
	Tags     []string
	Progress subscriptionProgress
}

func validateSubscriptionProgress(progress subscriptionProgress) error {
	for _, field := range []struct {
		name  string
		value *string
	}{{"acknowledged_cursor", progress.AcknowledgedCursor}, {"pending_cursor", progress.PendingCursor}, {"pending_receipt", progress.PendingReceipt}, {"last_acknowledged_receipt", progress.LastAcknowledgedReceipt}} {
		if field.value != nil && *field.value == "" {
			return fmt.Errorf("%s must be null or nonempty", field.name)
		}
	}
	if (progress.PendingCursor == nil) != (progress.PendingReceipt == nil) {
		return errors.New("pending cursor and receipt must both be null or nonempty")
	}
	return nil
}

func (store *noteStore) createWorkspaceSubscription(ctx context.Context, owner string, tags []string) (workspaceSubscription, error) {
	if strings.TrimSpace(owner) == "" {
		return workspaceSubscription{}, errors.New("subscription owner must not be empty")
	}
	normalized, err := normalizeSubscriptionTags(tags)
	if err != nil {
		return workspaceSubscription{}, err
	}
	id, err := randomOAuthSecret()
	if err != nil {
		return workspaceSubscription{}, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return workspaceSubscription{}, err
	}
	_, err = store.database.ExecContext(ctx, `INSERT INTO workspace_subscriptions(subscription_id,owner_id,tags) VALUES(?,?,?)`, id, owner, string(encoded))
	return workspaceSubscription{ID: id, OwnerID: owner, Tags: normalized}, err
}

func readWorkspaceSubscription(ctx context.Context, query rowQueryer, owner, id string) (workspaceSubscription, error) {
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(id) == "" {
		return workspaceSubscription{}, errors.New("subscription owner and ID must not be empty")
	}
	var subscription workspaceSubscription
	var tagsJSON string
	p := &subscription.Progress
	err := query.QueryRowContext(ctx, `SELECT subscription_id,owner_id,tags,acknowledged_cursor,pending_cursor,pending_receipt,last_acknowledged_receipt FROM workspace_subscriptions WHERE subscription_id=? AND owner_id=?`, id, owner).Scan(&subscription.ID, &subscription.OwnerID, &tagsJSON, &p.AcknowledgedCursor, &p.PendingCursor, &p.PendingReceipt, &p.LastAcknowledgedReceipt)
	if err != nil {
		return workspaceSubscription{}, err
	}
	if err := json.Unmarshal([]byte(tagsJSON), &subscription.Tags); err != nil {
		return workspaceSubscription{}, errors.New("stored subscription tags must be a JSON string array")
	}
	normalized, err := normalizeSubscriptionTags(subscription.Tags)
	if err != nil {
		return workspaceSubscription{}, err
	}
	if len(normalized) != len(subscription.Tags) {
		return workspaceSubscription{}, errors.New("stored subscription tags contain duplicates")
	}
	for i, tag := range normalized {
		if tag != subscription.Tags[i] {
			return workspaceSubscription{}, errors.New("stored subscription tags are not normalized")
		}
	}
	if err := validateSubscriptionProgress(*p); err != nil {
		return workspaceSubscription{}, err
	}
	return subscription, nil
}

func (store *noteStore) getWorkspaceSubscription(ctx context.Context, owner, id string) (workspaceSubscription, error) {
	return readWorkspaceSubscription(ctx, store.database, owner, id)
}

var errSubscriptionProgressConflict = errors.New("subscription progress does not match expected state")

func sameOptionalString(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func sameSubscriptionProgress(a, b subscriptionProgress) bool {
	return sameOptionalString(a.AcknowledgedCursor, b.AcknowledgedCursor) && sameOptionalString(a.PendingCursor, b.PendingCursor) && sameOptionalString(a.PendingReceipt, b.PendingReceipt) && sameOptionalString(a.LastAcknowledgedReceipt, b.LastAcknowledgedReceipt)
}

func (store *noteStore) updateWorkspaceSubscriptionProgress(ctx context.Context, owner, id string, expected, next subscriptionProgress) error {
	if err := validateSubscriptionProgress(expected); err != nil {
		return err
	}
	if err := validateSubscriptionProgress(next); err != nil {
		return err
	}
	if next.PendingCursor != nil && !sameOptionalString(expected.AcknowledgedCursor, next.AcknowledgedCursor) {
		return errors.New("saving pending progress cannot advance acknowledged cursor")
	}
	tx, err := store.database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := readWorkspaceSubscription(ctx, tx, owner, id)
	if err != nil {
		return err
	}
	if !sameSubscriptionProgress(current.Progress, expected) {
		return errSubscriptionProgressConflict
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_subscriptions SET acknowledged_cursor=?,pending_cursor=?,pending_receipt=?,last_acknowledged_receipt=? WHERE subscription_id=? AND owner_id=? AND acknowledged_cursor IS ? AND pending_cursor IS ? AND pending_receipt IS ? AND last_acknowledged_receipt IS ?`, next.AcknowledgedCursor, next.PendingCursor, next.PendingReceipt, next.LastAcknowledgedReceipt, id, owner, expected.AcknowledgedCursor, expected.PendingCursor, expected.PendingReceipt, expected.LastAcknowledgedReceipt)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errSubscriptionProgressConflict
	}
	return tx.Commit()
}
