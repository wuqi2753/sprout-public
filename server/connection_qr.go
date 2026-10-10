package main

// REQ-073: docs/stories/v0.5.0/REQ-073-generate-connection-qr.md
import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

type connectionQR struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	ServerURL string `json:"server_url"`
	APIKey    string `json:"api_key"`
}

var connectionDomainLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var connectionAPIKey = regexp.MustCompile(`^[!-~]{1,512}$`)
var numericConnectionHost = regexp.MustCompile(`^[0-9.]+$`)

func normalizeConnectionQRURL(address string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(address))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(address, "#") || (parsed.EscapedPath() != "" && parsed.EscapedPath() != "/") {
		return "", errors.New("Server URL must be an HTTPS domain origin without credentials, API path, query or fragment")
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return "", errors.New("Server URL must use the default HTTPS port; do not add :8080")
	}
	host := strings.ToLower(parsed.Hostname())
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	if len(host) > 253 || len(labels) < 2 || numericConnectionHost.MatchString(host) {
		return "", errors.New("Server URL must use a valid domain, not an IP address or local hostname")
	}
	for _, label := range labels {
		if !connectionDomainLabel.MatchString(label) {
			return "", errors.New("Server URL contains an invalid domain label")
		}
	}
	return "https://" + host, nil
}

func encodeConnectionQR(address, apiKey string) (*qrcode.QRCode, error) {
	origin, err := normalizeConnectionQRURL(address)
	if err != nil {
		return nil, err
	}
	if !connectionAPIKey.MatchString(apiKey) {
		return nil, errors.New("SPROUT_API_KEY must contain 1 to 512 printable ASCII characters without spaces")
	}
	payload, err := json.Marshal(connectionQR{1, "pairing", origin, apiKey})
	if err != nil {
		return nil, errors.New("failed to encode connection fields")
	}
	code, err := qrcode.New(string(payload), qrcode.Medium)
	if err != nil {
		return nil, errors.New("failed to encode connection QR")
	}
	return code, nil
}

func generateConnectionQR(address, apiKey, outputPath string, terminal io.Writer) error {
	code, err := encodeConnectionQR(address, apiKey)
	if err != nil {
		return err
	}
	if outputPath != "" {
		png, err := code.PNG(768)
		if err != nil {
			return errors.New("failed to encode connection PNG")
		}
		file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("create connection PNG (existing files are never overwritten): %w", err)
		}
		_, writeError := file.Write(png)
		closeError := file.Close()
		if err := errors.Join(writeError, closeError); err != nil {
			return fmt.Errorf("write connection PNG: %w", err)
		}
		return nil
	}
	// Explicit black foreground and white background work in either terminal theme.
	bitmap := code.Bitmap()
	var rendering strings.Builder
	for row := 0; row < len(bitmap); row += 2 {
		rendering.WriteString("\x1b[30;47m")
		for column, upper := range bitmap[row] {
			lower := row+1 < len(bitmap) && bitmap[row+1][column]
			switch {
			case upper && lower:
				rendering.WriteRune('█')
			case upper:
				rendering.WriteRune('▀')
			case lower:
				rendering.WriteRune('▄')
			default:
				rendering.WriteByte(' ')
			}
		}
		rendering.WriteString("\x1b[0m\n")
	}
	if _, err := io.WriteString(terminal, rendering.String()); err != nil {
		return fmt.Errorf("display connection QR: %w", err)
	}
	return nil
}
