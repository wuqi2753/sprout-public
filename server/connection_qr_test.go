package main

// REQ-073: offline generation, private output and failure boundaries.
import (
	"bytes"
	"errors"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConnectionQRURL(t *testing.T) {
	for _, address := range []string{"https://memo.example.com", " https://MEMO.example.com:443/ "} {
		origin, err := normalizeConnectionQRURL(address)
		if err != nil || origin != "https://memo.example.com" {
			t.Fatalf("normalize valid origin: %q %v", origin, err)
		}
	}
	for _, address := range []string{"", "http://memo.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://bad_host.example.com", "https://-bad.example.com", "https://memo..example.com", "https://memo.example.com:8080", "https://memo.example.com/api/v1", "https://memo.example.com?secret=private", "https://memo.example.com?", "https://memo.example.com#", strings.Join([]string{"https:", "//user:private", "@", "memo.example.com"}, ""), "https://memo.example.com/%2f"} {
		if _, err := normalizeConnectionQRURL(address); err == nil {
			t.Fatal("accepted invalid origin")
		} else if strings.Contains(err.Error(), "private") {
			t.Fatal("URL error leaked credentials")
		}
	}
}

func TestConnectionQRKeyAndPayload(t *testing.T) {
	for _, key := range []string{"", "private key", "private\nkey", "private\x00key", "私密", strings.Repeat("x", 513)} {
		if _, err := encodeConnectionQR("https://memo.example.com", key); err == nil {
			t.Fatal("accepted invalid Key")
		} else if key != "" && strings.Contains(err.Error(), key) {
			t.Fatal("error leaked Key")
		}
	}
	key := `key-with-"quote-and-backslash\`
	code, err := encodeConnectionQR("https://memo.example.com", key)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(code.Content, `"type":"pairing"`) || strings.Contains(code.Content, "expires_at") {
		t.Fatal("unexpected connection payload")
	}
}

func TestConnectionQRPNGAndTerminal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connection.png")
	var terminal bytes.Buffer
	if err := generateConnectionQR("https://memo.example.com", "test-key", path, &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Len() != 0 {
		t.Fatal("PNG mode unexpectedly displayed credentials")
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	image, err := png.Decode(bytes.NewReader(contents))
	if err != nil || image.Bounds().Dx() != 768 {
		t.Fatal("invalid PNG output", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("PNG must have mode 600", err)
	}
	if err := generateConnectionQR("https://memo.example.com", "other-key", path, &terminal); err == nil {
		t.Fatal("overwrote existing PNG")
	}
	unchanged, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, unchanged) {
		t.Fatal("existing output changed")
	}
	if err := generateConnectionQR("https://memo.example.com", "test-key", "", &terminal); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(terminal.String(), "\x1b[30;47m") || strings.Contains(terminal.String(), "test-key") {
		t.Fatal("terminal output is not a private QR matrix")
	}
	if err := generateConnectionQR("https://memo.example.com", "test-key", filepath.Join(path, "invalid.png"), io.Discard); err == nil {
		t.Fatal("ignored output failure")
	}
}

type rejectedQRWriter struct{}

func (rejectedQRWriter) Write([]byte) (int, error) { return 0, errors.New("fixture write failure") }
func TestConnectionQRTerminalFailure(t *testing.T) {
	if err := generateConnectionQR("https://memo.example.com", "test-key", "", rejectedQRWriter{}); err == nil {
		t.Fatal("ignored terminal write failure")
	}
}
