package main

// REQ-077: page/QR public boundary and application lifecycle.
import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"html"
	"image/png"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDeviceQRAppContract(t *testing.T) {
	qr, err := encodeDeviceQR("https://notes.example.com", "ABCD-1234", 2000)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal([]byte(qr.Content), &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 5 || fields["version"] != float64(1) || fields["type"] != "cli" || fields["server_url"] != "https://notes.example.com" || fields["user_code"] != "ABCD-1234" || fields["expires_at"] != time.Unix(2000, 0).UTC().Format(time.RFC3339) {
		t.Fatal(fields)
	}
	for _, invalid := range []string{strings.Join([]string{"https:", "//secret", "@", "notes.example.com"}, ""), "https://notes.example.com/path"} {
		if _, err := encodeDeviceQR(invalid, "ABCD-1234", 2000); err == nil {
			t.Fatal("invalid origin accepted")
		}
	}
	if _, err := encodeDeviceQR("https://notes.example.com", "secret", 2000); err == nil {
		t.Fatal("invalid code accepted")
	}
}

func TestDevicePageLifecycle(t *testing.T) {
	store := openTestStore(t)
	store.publicOrigin = "https://notes.example.com"
	now := int64(1000)
	store.now = func() time.Time { return time.Unix(now, 0) }
	h := newHandler("test-key", store)
	a := createOAuthApplication(t, h)
	path := a["verification_uri_complete"].(string)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", path, nil)
	r.Host = "evil.example"
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `data-remaining="120">02:00`) || strings.Contains(body, "有效至") {
		t.Fatal("incorrect countdown")
	}
	now += 61
	delayed := httptest.NewRecorder()
	h.ServeHTTP(delayed, httptest.NewRequest("GET", path, nil))
	if !strings.Contains(delayed.Body.String(), `data-remaining="59">00:59`) {
		t.Fatal("refresh reset countdown")
	}
	now -= 61
	if !strings.Contains(body, a["user_code"].(string)) || !strings.Contains(body, cliScope) || !strings.Contains(body, "https://notes.example.com") || !strings.Contains(body, "用已连接此 Server") {
		t.Fatal(body)
	}
	for _, secret := range []string{a["device_code"].(string), "test-key", "device_code", "api_key", "access_token", "refresh_token", "evil.example", "<form"} {
		if strings.Contains(body, secret) {
			t.Fatalf("page contains forbidden value %s", secret)
		}
	}
	encoded := strings.SplitN(strings.SplitN(body, "data:image/png;base64,", 2)[1], `"`, 2)[0]
	pngBytes, err := base64.StdEncoding.DecodeString(html.UnescapeString(encoded))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := png.Decode(bytes.NewReader(pngBytes)); err != nil {
		t.Fatal("invalid embedded PNG", err)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal(w.Header())
	}
	var status string
	if err := store.database.QueryRow(`SELECT status FROM oauth_device_requests WHERE user_code=?`, a["user_code"]).Scan(&status); err != nil || status != "pending" {
		t.Fatal("page altered status", status, err)
	}
	now += 120
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "申请已过期") {
		t.Fatal(w.Code)
	}
}

func TestDevicePageErrorsAndEscape(t *testing.T) {
	store := openTestStore(t)
	h := newHandler("test-key", store)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/oauth/device", nil))
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
	store.publicOrigin = "https://notes.example.com"
	cases := []struct {
		method, path string
		code         int
	}{
		{"GET", "/oauth/device", 200}, {"POST", "/oauth/device", 405},
		{"GET", "/oauth/device?device_code=secret", 400},
		{"GET", "/oauth/device?user_code=", 400},
		{"GET", "/oauth/device?user_code=ABCD-1234&user_code=ABCD-1234", 400},
		{"GET", "/oauth/device?user_code=ABCD-1234&extra=1", 400},
		{"GET", "/oauth/device?user_code=ABCD-1234", 404},
	}
	for _, c := range cases {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(c.method, c.path, nil))
		if w.Code != c.code {
			t.Fatalf("%s %d %s", c.path, w.Code, w.Body.String())
		}
	}
	for _, status := range []string{"approved", "denied", "consumed"} {
		seedDeviceRequest(t, store, status, time.Now().Add(time.Hour).Unix())
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/oauth/device?user_code=ABCD-1234", nil))
		if w.Code != 200 || strings.Contains(w.Body.String(), `class="qr"`) || !strings.Contains(w.Body.String(), `data-state="`+status+`"`) {
			t.Fatal(status, w.Code)
		}
		if _, err := store.database.Exec(`DELETE FROM oauth_device_requests`); err != nil {
			t.Fatal(err)
		}
	}
	seedDeviceRequest(t, store, "pending", time.Now().Add(time.Hour).Unix())
	if _, err := store.database.Exec(`UPDATE oauth_device_requests SET scope='<script>alert(1)</script>'`); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/oauth/device?user_code=ABCD-1234", nil))
	if w.Code != 200 || strings.Contains(w.Body.String(), "<script>alert(1)") || !strings.Contains(w.Body.String(), "&lt;script&gt;") {
		t.Fatal("unescaped scope", w.Code)
	}
	if _, err := store.database.Exec(`DROP TABLE oauth_device_secrets; DROP TABLE oauth_device_requests`); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/oauth/device?user_code=ABCD-1234", nil))
	if w.Code != 500 {
		t.Fatal(w.Code)
	}
}

// REQ-098: success means the CLI consumed the approved request, not just a scan.
func TestDevicePageConsumedRemainsSuccessfulAfterExpiry(t *testing.T) {
	store := openTestStore(t)
	store.publicOrigin = "https://notes.example.com"
	seedDeviceRequest(t, store, "consumed", time.Now().Add(-time.Hour).Unix())
	w := httptest.NewRecorder()
	newHandler("test-key", store).ServeHTTP(w, httptest.NewRequest("GET", "/oauth/device?user_code=ABCD-1234", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "连接成功") || strings.Contains(w.Body.String(), `class="qr"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'self'") || !strings.Contains(w.Body.String(), `setTimeout(refreshStatus, 3000)`) {
		t.Fatal("missing same-origin polling policy")
	}
}
