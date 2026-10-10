package main

// REQ-077: docs/stories/v0.5.0/REQ-077-device-qr-page.md
import (
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

type deviceQR struct {
	Version   int    `json:"version"`
	Type      string `json:"type"`
	ServerURL string `json:"server_url"`
	UserCode  string `json:"user_code"`
	ExpiresAt string `json:"expires_at"`
}

func encodeDeviceQR(origin, code string, expiry int64) (*qrcode.QRCode, error) {
	trusted, err := normalizeConnectionQRURL(origin)
	if err != nil {
		return nil, err
	}
	if !userCodePattern.MatchString(code) || expiry <= 0 {
		return nil, errors.New("invalid device QR fields")
	}
	payload, err := json.Marshal(deviceQR{1, "cli", trusted, code, time.Unix(expiry, 0).UTC().Format(time.RFC3339)})
	if err != nil {
		return nil, err
	}
	return qrcode.New(string(payload), qrcode.Medium)
}

// REQ-098: public status only; serial polling never approves or receives credentials.
const deviceCountdownScript = `(() => {
let stopped = false;
let countdownElement;
let countdownDeadline;
window.addEventListener("pagehide", () => { stopped = true; });
function updateCountdown() {
 const countdown = document.getElementById("countdown");
 if (!countdown) return;
 if (countdown !== countdownElement) {
  countdownElement = countdown;
  countdownDeadline = Date.now() + Number(countdown.dataset.remaining) * 1000;
 }
 const remaining = Math.max(0, Math.ceil((countdownDeadline - Date.now()) / 1000));
 countdown.textContent = remaining > 0 ? String(Math.floor(remaining / 60)).padStart(2, "0") + ":" + String(remaining % 60).padStart(2, "0") : "已过期，请在 CLI 重新发起登录";
 const qr = document.querySelector(".qr");
 if (remaining === 0 && qr) qr.hidden = true;
}
async function refreshStatus() {
 const main = document.querySelector("main");
 if (stopped || !main || !["pending", "approved"].includes(main.dataset.state)) return;
 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), 8000);
 try {
  const response = await fetch(location.pathname + location.search, {cache:"no-store", redirect:"error", signal:controller.signal});
  if (!response.ok) throw new Error("status unavailable");
  const next = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("main");
  if (!next || !["pending", "approved", "denied", "consumed", "expired"].includes(next.dataset.state)) throw new Error("invalid status");
  if (!stopped) { main.replaceWith(next); document.getElementById("poll-error").textContent = ""; updateCountdown(); }
 } catch {
  if (!stopped) document.getElementById("poll-error").textContent = "暂时无法查询授权状态，正在重试…";
 } finally {
  clearTimeout(timeout);
  if (!stopped) setTimeout(refreshStatus, 3000);
 }
}
updateCountdown();
setInterval(updateCountdown, 1000);
setTimeout(refreshStatus, 3000);
})();`

// REQ-098: ship the App logo inside the binary; no third-party requests.
//
//go:embed device-logo.png
var deviceLogoPNG []byte

var devicePageTemplate = template.Must(template.New("device").Parse(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sprout CLI 授权</title>
<style>
body{font:16px system-ui,sans-serif;margin:0}
.brand{position:absolute;top:24px;left:24px;display:flex;align-items:center;gap:10px;height:48px;font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.2px}.brand-logo{width:48px;height:48px;flex:none;overflow:hidden;border-radius:12px}.brand img{width:100%;height:100%;display:block;transform:scale(1.4)}
.page{--background:oklch(0.2679 0.0036 106.6427);--text:oklch(0.8074 0.0142 93.0137);--muted:oklch(0.7713 0.0169 99.0657);--border:oklch(0.3618 0.0101 106.8928);--primary:oklch(0.6724 0.1308 38.7559);--input:oklch(0.4336 0.0113 100.2195);background:var(--background);color:var(--text);min-height:100vh;box-sizing:border-box;padding:80px 24px 48px;color-scheme:dark}
main{max-width:440px;margin:auto}h1{font-size:24px}p{line-height:1.7;overflow-wrap:anywhere}.qr{width:288px;height:288px;max-width:100%;display:block;background:white}small{color:var(--muted)}
#countdown{color:var(--primary);font-weight:600;font-variant-numeric:tabular-nums}
#day-mode{position:absolute;top:24px;right:24px;width:48px;height:48px;margin:0;opacity:0;z-index:2;cursor:pointer}
.theme-toggle{position:absolute;top:24px;right:24px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:12px}
.theme-track{width:44px;height:24px;box-sizing:border-box;padding:2px;border-radius:12px;background:var(--primary)}
.theme-thumb{width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--background);box-shadow:0 1px 3px #0003;transform:translateX(20px);transition:transform 200ms}
.theme-thumb svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#day-mode:focus-visible~.page .theme-toggle{outline:2px solid var(--text);outline-offset:4px}
.sun-icon{display:none}
#day-mode:checked~.page{--background:oklch(0.9818 0.0054 95.0986);--text:oklch(0.3438 0.0269 95.7226);--muted:oklch(0.6059 0.0075 97.4233);--border:oklch(0.8847 0.0069 97.3627);--primary:oklch(0.6171 0.1375 39.0427);--input:oklch(0.7621 0.0156 98.3528);color-scheme:light}
#day-mode:checked~.page #countdown{color:var(--muted)}
#day-mode:checked~.page .theme-track{background:var(--input)}
#day-mode:checked~.page .theme-thumb{transform:translateX(0)}
#day-mode:checked~.page .moon-icon{display:none}#day-mode:checked~.page .sun-icon{display:block}
@media(prefers-reduced-motion:reduce){.theme-thumb{transition:none}}
</style>
<input type="checkbox" id="day-mode" aria-label="白天模式">
<div class="page"><label class="theme-toggle" for="day-mode" title="切换白天／黑夜模式"><span class="theme-track"><span class="theme-thumb"><svg class="moon-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg><svg class="sun-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg></span></span></label>
<div class="brand" aria-label="Sprout"><span class="brand-logo"><img alt="" src="data:image/png;base64,{{.Logo}}"></span><span>Sprout</span></div>
<main data-state="{{.Status}}"><h1>{{if .Result}}{{.Result}}{{else}}连接 Sprout CLI{{end}}</h1><p>Server：{{.Origin}}</p>
{{if .QR}}<img class="qr" alt="CLI 授权申请二维码" src="data:image/png;base64,{{.QR}}">
<p>核对码：{{.Code}}</p><p>权限：{{.Scope}}</p><p>剩余时间：<span id="countdown" data-deadline="{{.Expiry}}" data-remaining="{{.Remaining}}">{{.Countdown}}</span></p>
<p>用已连接此 Server 的 Sprout App 扫码，核对 CLI 上的核对码后，选择允许或拒绝。</p><small>仅批准你自己发起的申请。扫码不会自动授权，客户端名称不能证明设备身份。</small>
{{else if .Result}}<p>{{.Explanation}}</p>{{else}}<p>请先在 CLI 发起登录，再打开 CLI 提供的完整验证链接。</p>{{end}}</main><p id="poll-error" role="status" aria-live="polite"></p></div><script>{{.Script}}</script></html>`))

func (store *noteStore) registerDevicePage(mux *http.ServeMux) {
	mux.HandleFunc("/oauth/device", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		scriptHash := sha256.Sum256([]byte(deviceCountdownScript))
		w.Header().Set("Content-Security-Policy", "script-src 'sha256-"+base64.StdEncoding.EncodeToString(scriptHash[:])+"'; connect-src 'self'; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "GET is required", 405)
			return
		}
		if store.publicOrigin == "" {
			http.Error(w, "Server public origin is not configured", 503)
			return
		}
		query, err := parseDevicePageQuery(r)
		if err != nil {
			http.Error(w, "Only one valid user_code is allowed", 400)
			return
		}
		fields := struct {
			Origin, QR, Scope, Countdown, Code, Status, Result, Explanation, Logo string
			Remaining, Expiry                                                     int64
			Script                                                                template.JS
		}{Origin: store.publicOrigin, Logo: base64.StdEncoding.EncodeToString(deviceLogoPNG), Script: template.JS(deviceCountdownScript)}
		if query != "" {
			var status string
			var expiry int64
			err := store.database.QueryRowContext(r.Context(), `SELECT scope,expires_at,status FROM oauth_device_requests WHERE user_code=?`, query).Scan(&fields.Scope, &expiry, &status)
			if errors.Is(err, sql.ErrNoRows) {
				http.Error(w, "Device request does not exist", 404)
				return
			}
			if err != nil {
				http.Error(w, "Failed to read device request", 500)
				return
			}
			fields.Code, fields.Status, fields.Expiry = query, status, expiry
			if status != "consumed" && status != "denied" && store.now().Unix() >= expiry {
				fields.Status = "expired"
			}
			switch fields.Status {
			case "pending":
			case "approved":
				fields.Result, fields.Explanation = "已授权", "等待 CLI 完成连接，请返回终端查看。"
			case "consumed":
				fields.Result, fields.Explanation = "连接成功", "CLI 已领取凭据，可以关闭此页面。"
			case "denied":
				fields.Result, fields.Explanation = "已拒绝授权", "未向此次申请授予权限。"
			case "expired":
				fields.Result, fields.Explanation = "申请已过期", "请在 CLI 重新发起登录。"
			default:
				http.Error(w, "Invalid stored request status", 500)
				return
			}
			if fields.Status == "pending" {
				qr, err := encodeDeviceQR(store.publicOrigin, query, expiry)
				if err != nil {
					http.Error(w, "Failed to encode device QR", 500)
					return
				}
				png, err := qr.PNG(384)
				if err != nil {
					http.Error(w, "Failed to render device QR", 500)
					return
				}
				fields.QR = base64.StdEncoding.EncodeToString(png)
				fields.Remaining = expiry - store.now().Unix()
				fields.Countdown = fmt.Sprintf("%02d:%02d", fields.Remaining/60, fields.Remaining%60)
			}
		}
		// Render before writing headers so failures can return a proper 500.
		var body strings.Builder
		if err := devicePageTemplate.Execute(&body, fields); err != nil {
			http.Error(w, "Failed to render device page", 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, err = w.Write([]byte(body.String()))
		if err != nil {
			log.Print("device page response write failed")
			return
		}
	})
}

func parseDevicePageQuery(r *http.Request) (string, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return "", err
	}
	if len(query) == 0 {
		return "", nil
	}
	values, exists := query["user_code"]
	if len(query) != 1 || !exists || len(values) != 1 || !userCodePattern.MatchString(values[0]) {
		return "", errors.New("invalid user_code query")
	}
	return values[0], nil
}
