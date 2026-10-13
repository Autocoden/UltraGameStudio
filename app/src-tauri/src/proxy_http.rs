//! Generic desktop-side HTTP proxy for the Tauri WebView.
//!
//! The WebView's native `fetch()` is subject to browser CORS: cross-origin
//! upstreams that omit `Access-Control-Allow-Origin` (many model / image
//! gateways) make the request fail with an opaque `Failed to fetch`, even
//! though the same key/endpoint works from a normal web page (same-origin) or
//! from a server. Routing the request through Rust (`ureq`) sidesteps CORS
//! entirely because it is not a browser context.
//!
//! This is a *generic* forwarder: it takes an arbitrary method/url/headers/body
//! and returns the upstream status + headers + body verbatim. It performs no
//! provider-specific translation. Binary payloads (PNG/JPEG/…) are carried as
//! Base64 in and out so bytes survive the IPC boundary intact (a UTF-8 string
//! round-trip would corrupt non-text bytes).
//!
//! Non-2xx upstream responses are returned as a normal `ProxyHttpResponse` (not
//! an `Err`), mirroring the browser `fetch()` contract where a 4xx/5xx still
//! resolves and the caller inspects `response.ok` / `response.status`.

use std::io::Read;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

/// One header as a name/value pair (preserves order + duplicates). Used for
/// both the request (deserialized) and the response (serialized).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProxyHttpHeader {
    pub name: String,
    pub value: String,
}

/// Request payload sent from the JS `tauriFetch()` wrapper.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpRequest {
    /// HTTP method, e.g. "GET" / "POST". Defaults to GET when empty.
    #[serde(default)]
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<ProxyHttpHeader>,
    /// Base64-encoded request body. `None`/empty means no body.
    #[serde(default)]
    pub body_base64: Option<String>,
    /// Per-call timeout in milliseconds. Falls back to a default when absent.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Maximum decoded response bytes. None keeps ordinary callers unlimited.
    #[serde(default)]
    pub max_response_bytes: Option<u64>,
}

/// Response returned to JS; rebuilt into a standard `Response` there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<ProxyHttpHeader>,
    /// Base64-encoded response body.
    pub body_base64: String,
    /// Final URL after any redirects ureq followed (best-effort).
    pub url: String,
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_TIMEOUT: Duration = Duration::from_secs(1800);

fn status_text_for(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

fn collect_response(
    response: ureq::Response,
    final_url: String,
    max_response_bytes: Option<u64>,
    deadline: Option<Instant>,
) -> Result<ProxyHttpResponse, String> {
    assert_http_deadline(deadline)?;
    let status = response.status();
    let status_text = {
        let native = response.status_text().trim().to_string();
        if native.is_empty() {
            status_text_for(status).to_string()
        } else {
            native
        }
    };
    let mut headers = Vec::new();
    for name in response.headers_names() {
        if let Some(value) = response.header(&name) {
            headers.push(ProxyHttpHeader {
                name,
                value: value.to_string(),
            });
        }
    }

    let mut bytes = Vec::new();
    let limit_plus_one = max_response_bytes.map(|limit| limit.saturating_add(1)).unwrap_or(u64::MAX);
    response
        .into_reader().take(limit_plus_one)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("proxy_http: failed to read upstream body: {err}"))?;
    if max_response_bytes.is_some_and(|limit| bytes.len() as u64 > limit) {
        return Err("HTTP_RESPONSE_TOO_LARGE: proxy_http response exceeded byte limit".to_string());
    }

    let payload = ProxyHttpResponse {
        status,
        status_text,
        headers,
        body_base64: STANDARD.encode(&bytes),
        url: final_url,
    };
    assert_http_deadline(deadline)?;
    Ok(payload)
}

// The std resolver cannot be interrupted on every OS. Bound the HTTP worker's wait,
// drop late DNS results, and never dispatch a socket after the original deadline.
fn resolve_with_deadline<F>(netloc: String, deadline: Instant, resolve: F) -> std::io::Result<Vec<SocketAddr>>
where
    F: FnOnce(&str) -> std::io::Result<Vec<SocketAddr>> + Send + 'static,
{
    let remaining = deadline.checked_duration_since(Instant::now())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP_TIMEOUT: DNS budget exhausted"))?;
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::Builder::new().name("proxy-http-dns".to_string()).spawn(move || {
        let _ = send.send(resolve(&netloc));
    })?;
    match receive.recv_timeout(remaining) {
        Ok(addresses) if Instant::now() < deadline => addresses,
        Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) =>
            Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP_TIMEOUT: DNS budget exhausted")),
        Err(mpsc::RecvTimeoutError::Disconnected) =>
            Err(std::io::Error::new(std::io::ErrorKind::Other, "proxy_http: DNS resolver stopped")),
    }
}

fn assert_http_deadline(deadline: Option<Instant>) -> Result<(), String> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err("HTTP_TIMEOUT: proxy_http hard budget exhausted".to_string());
    }
    Ok(())
}

fn request_with_deadline(req: ureq::Request, deadline: Option<Instant>) -> Result<ureq::Request, String> {
    if let Some(deadline) = deadline {
        let remaining = deadline.checked_duration_since(Instant::now()).filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| "HTTP_TIMEOUT: proxy_http hard budget exhausted before dispatch".to_string())?;
        Ok(req.timeout(remaining))
    } else {
        Ok(req)
    }
}

#[cfg(test)]
fn proxy_http_blocking(request: ProxyHttpRequest) -> Result<ProxyHttpResponse, String> {
    proxy_http_blocking_started_at(request, Instant::now())
}

fn proxy_http_blocking_started_at(request: ProxyHttpRequest, started_at: Instant) -> Result<ProxyHttpResponse, String> {
    let url = request.url.trim();
    if url.is_empty() {
        return Err("proxy_http: url is empty".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("proxy_http: unsupported url scheme: {url}"));
    }

    let method = {
        let m = request.method.trim();
        if m.is_empty() {
            "GET".to_string()
        } else {
            m.to_ascii_uppercase()
        }
    };

    if request.timeout_ms.is_some_and(|timeout| timeout == 0 || timeout > MAX_TIMEOUT.as_millis() as u64) {
        return Err("HTTP_INVALID_BUDGET: proxy_http timeout must be between 1 and 1800000ms".to_string());
    }
    let timeout = request
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_TIMEOUT);

    // Do not start a fresh budget when a request waited in the blocking pool.
    let timeout = if request.timeout_ms.is_some() {
        timeout.checked_sub(started_at.elapsed()).filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| "HTTP_TIMEOUT: proxy_http hard budget exhausted before dispatch".to_string())?
    } else {
        timeout
    };
    let mut builder = ureq::AgentBuilder::new().timeout(timeout);
    if let Some(timeout_ms) = request.timeout_ms {
        let deadline = started_at + Duration::from_millis(timeout_ms);
        builder = builder.resolver(move |netloc: &str| {
            if let Ok(address) = netloc.parse::<SocketAddr>() {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP_TIMEOUT: DNS budget exhausted"));
                }
                return Ok(vec![address]);
            }
            resolve_with_deadline(netloc.to_string(), deadline, |host| host.to_socket_addrs().map(Iterator::collect))
        });
    }
    let agent = builder.build();

    let mut req = agent.request(&method, url);
    for header in &request.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        // ureq sets these itself; forwarding a stale/duplicate value can corrupt
        // the transfer framing.
        let lname = name.to_ascii_lowercase();
        if lname == "host" || lname == "content-length" || lname == "connection" {
            continue;
        }
        req = req.set(name, &header.value);
    }

    let body_bytes = match request.body_base64.as_deref() {
        Some(b64) if !b64.is_empty() => Some(
            STANDARD
                .decode(b64)
                .map_err(|err| format!("proxy_http: invalid base64 body: {err}"))?,
        ),
        _ => None,
    };

    let final_url = url.to_string();
    let deadline = request.timeout_ms.map(|timeout_ms| started_at + Duration::from_millis(timeout_ms));
    let req = request_with_deadline(req, deadline)?;
    let result = match body_bytes {
        Some(bytes) => req.send_bytes(&bytes),
        None => req.call(),
    };

    match result {
        Ok(response) => collect_response(response, final_url, request.max_response_bytes, deadline),
        // A non-2xx status is a normal HTTP response for our purposes: mirror
        // browser fetch() semantics and return it instead of erroring.
        Err(ureq::Error::Status(_, response)) => collect_response(response, final_url, request.max_response_bytes, deadline),
        Err(err) => Err(format!("proxy_http: request failed: {err}")),
    }
}

/// Tauri command: forward one HTTP request from the WebView through Rust to
/// bypass CORS. Runs on the blocking pool since `ureq` is synchronous.
#[tauri::command]
pub async fn proxy_http(request: ProxyHttpRequest) -> Result<ProxyHttpResponse, String> {
    let started_at = Instant::now();
    tauri::async_runtime::spawn_blocking(move || proxy_http_blocking_started_at(request, started_at))
        .await
        .map_err(|err| format!("proxy_http: task join error: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Instant;

    fn serve_once(body: Vec<u8>) -> (String, mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/completion", listener.local_addr().unwrap());
        let (stop, stopped) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(&[13, 10, 13, 10]) {
                if stream.read(&mut byte).unwrap_or(0) == 0 { return; }
                request.push(byte[0]);
            }
            let headers = ["HTTP/1.1 200 OK", "Content-Type: text/plain", "Connection: close", "", ""]
                .join(&String::from_utf8(vec![13, 10]).unwrap());
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
            stream.flush().unwrap();
            // Deliberately do not send EOF until the caller finishes.
            let _ = stopped.recv_timeout(Duration::from_secs(2));
        });
        (url, stop, thread)
    }

    #[test]
    fn oversized_stream_stops_at_limit_plus_one_without_waiting_for_eof() {
        let (url, stop, server) = serve_once(vec![b'x'; 129]);
        let request: ProxyHttpRequest = serde_json::from_value(serde_json::json!({
            "url": url, "timeoutMs": 400, "maxResponseBytes": 128,
        })).unwrap();
        let started = Instant::now();
        let result = proxy_http_blocking(request);
        let elapsed = started.elapsed();
        let _ = stop.send(());
        server.join().unwrap();
        let error = result.expect_err("oversized response must be rejected");
        assert!(error.contains("HTTP_RESPONSE_TOO_LARGE"), "{error}");
        assert!(elapsed < Duration::from_millis(300), "waited {elapsed:?} for EOF");
    }

    #[test]
    fn explicit_timeout_bounds_real_body_reads_not_only_response_headers() {
        let (url, stop, server) = serve_once(b"waiting".to_vec());
        let request: ProxyHttpRequest = serde_json::from_value(serde_json::json!({
            "url": url, "timeoutMs": 60, "maxResponseBytes": 128,
        })).unwrap();
        let started = Instant::now();
        let result = proxy_http_blocking(request);
        let elapsed = started.elapsed();
        let _ = stop.send(());
        server.join().unwrap();
        assert!(result.is_err(), "hanging body cannot resolve successfully");
        assert!(elapsed < Duration::from_millis(600), "read ran for {elapsed:?}");
    }

    #[test]
    fn blocking_pool_delay_consumes_the_original_request_budget_before_network_dispatch() {
        let request: ProxyHttpRequest = serde_json::from_value(serde_json::json!({
            "url": "http://127.0.0.1:1/never-send", "timeoutMs": 30, "maxResponseBytes": 128,
        })).unwrap();
        let started_at = Instant::now() - Duration::from_millis(60);
        let error = proxy_http_blocking_started_at(request, started_at).unwrap_err();
        assert!(error.contains("HTTP_TIMEOUT"), "{error}");
    }

    #[test]
    fn bounded_dns_lookup_returns_before_a_stalled_resolver_and_discards_late_addresses() {
        let deadline = Instant::now() + Duration::from_millis(30);
        let started = Instant::now();
        let result = resolve_with_deadline("127.0.0.1:80".to_string(), deadline, |_| {
            std::thread::sleep(Duration::from_millis(180));
            Ok(vec!["127.0.0.1:80".parse().unwrap()])
        });
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(150), "DNS wait exceeded the hard budget");
    }

    #[test]
    fn expired_budget_never_returns_a_buffered_success() {
        let response = ureq::Response::new(200, "OK", "bounded body").unwrap();
        let error = collect_response(response, "http://local/review".to_string(), Some(128),
            Some(Instant::now() - Duration::from_millis(1))).unwrap_err();
        assert!(error.contains("HTTP_TIMEOUT"), "{error}");
    }

    #[test]
    fn request_preparation_does_not_restart_the_upstream_body_timeout() {
        let (url, stop, server) = serve_once(b"waiting".to_vec());
        let req = ureq::get(&url).timeout(Duration::from_millis(400));
        let deadline = Instant::now() + Duration::from_millis(30);
        let started = Instant::now();
        let response = request_with_deadline(req, Some(deadline)).unwrap().call().unwrap();
        let result = collect_response(response, url, Some(128), Some(deadline));
        let elapsed = started.elapsed();
        let _ = stop.send(());
        server.join().unwrap();
        assert!(result.is_err(), "hanging body cannot return success");
        assert!(elapsed < Duration::from_millis(200), "restarted timeout: {elapsed:?}");
    }

    #[test]
    fn explicit_zero_timeout_is_not_extended_into_another_request() {
        let request: ProxyHttpRequest = serde_json::from_value(serde_json::json!({
            "url": "http://127.0.0.1:1/never-send", "timeoutMs": 0, "maxResponseBytes": 128,
        })).unwrap();
        let error = proxy_http_blocking(request).unwrap_err();
        assert!(error.contains("HTTP_INVALID_BUDGET"), "{error}");
    }
}
