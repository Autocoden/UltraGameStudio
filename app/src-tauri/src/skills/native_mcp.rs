//! Invocation-only foreground MCP transport. No WebView authority, no general
//! tools, no credential logging, and no completion-only reviewer fallback.
use super::native_cli::NativeSkillInvocation;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const HEADER_BYTES: usize = 8192;
const BODY_BYTES: usize = 131072;
const RESPONSE_BYTES: usize = 4 * 1024 * 1024;

struct Lifetime {
    closed: AtomicBool,
    // Once a complete authenticated request reaches dispatch, its bounded reply
    // owns delivery. Cancellation still revokes authority before any later call.
    dispatching: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
    wake: Condvar,
    expires: Instant,
    requests: AtomicUsize,
    max_requests: usize,
    invocation: Arc<NativeSkillInvocation>,
}
impl Lifetime {
    fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.invocation.revoke();
        }
        if let Ok(socket) = self.socket.lock() {
            if let Some(socket) = socket.as_ref() {
                let how = if self.dispatching.load(Ordering::SeqCst) {
                    Shutdown::Read
                } else {
                    Shutdown::Both
                };
                let _ = socket.shutdown(how);
            }
        }
        self.wake.notify_all();
        #[cfg(test)]
        tests::close_checkpoint(self.invocation.execution_run_id());
    }
    fn open(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && Instant::now() < self.expires
    }
}

pub(crate) struct NativeSkillMcpBridge {
    state: Arc<Lifetime>,
    url: String,
    // Kept in host memory; never Debug, emitted, or returned across IPC.
    authorization: String,
    workers: Mutex<Vec<JoinHandle<()>>>,
}
impl NativeSkillMcpBridge {
    pub(crate) fn start(
        invocation: Arc<NativeSkillInvocation>,
        max_requests: usize,
        lifetime: Duration,
    ) -> Result<Self, String> {
        if !(1..=256).contains(&max_requests)
            || lifetime.is_zero()
            || lifetime > Duration::from_secs(600)
        {
            return Err("SKILL_MCP_INVALID_LIMIT".into());
        }
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "SKILL_MCP_LISTEN_FAILED")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "SKILL_MCP_LISTEN_FAILED")?;
        let address = listener
            .local_addr()
            .map_err(|_| "SKILL_MCP_LISTEN_FAILED")?
            .to_string();
        let mut secret = [0_u8; 32];
        getrandom::getrandom(&mut secret).map_err(|_| "SKILL_MCP_AUTH_GENERATION_FAILED")?;
        let authorization = format!("Bearer {}", hex::encode(secret));
        let state = Arc::new(Lifetime {
            closed: AtomicBool::new(false),
            dispatching: AtomicBool::new(false),
            socket: Mutex::new(None),
            wake: Condvar::new(),
            expires: Instant::now() + lifetime,
            requests: AtomicUsize::new(0),
            max_requests,
            invocation,
        });
        let serving = Arc::clone(&state);
        let auth = authorization.clone();
        let host = address.clone();
        let worker = std::thread::Builder::new()
            .name("ugs-native-skills-mcp".into())
            .spawn(move || {
                while serving.open() {
                    match listener.accept() {
                        Ok((mut socket, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            if let Ok(mut slot) = serving.socket.lock() {
                                *slot = socket.try_clone().ok();
                            }
                            #[cfg(test)]
                            tests::dispatch_checkpoint(&format!("accept:{}", serving.invocation.execution_run_id()));
                            if serving.open() {
                                let reply = handle(&mut socket, &host, &auth, &serving);
                                send(&mut socket, reply);
                            }
                            let _ = socket.shutdown(Shutdown::Both);
                            serving.dispatching.store(false, Ordering::SeqCst);
                            if let Ok(mut slot) = serving.socket.lock() {
                                *slot = None;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if let Ok(slot) = serving.socket.lock() {
                                let _ = serving.wake.wait_timeout(slot, Duration::from_millis(10));
                            }
                        }
                        Err(_) => break,
                    }
                }
                serving.close();
            })
            .map_err(|_| {
                state.close();
                "SKILL_MCP_WORKER_FAILED"
            })?;
        let expiry = Arc::clone(&state);
        let timer = match std::thread::Builder::new()
            .name("ugs-native-skills-expiry".into())
            .spawn(move || {
                if let Ok(mut slot) = expiry.socket.lock() {
                    while expiry.open() {
                        let wait = expiry.expires.saturating_duration_since(Instant::now());
                        match expiry.wake.wait_timeout(slot, wait) {
                            Ok((next, _)) => slot = next,
                            Err(_) => {
                                expiry.close();
                                return;
                            }
                        }
                    }
                }
                expiry.close();
            }) {
            Ok(timer) => timer,
            Err(_) => {
                state.close();
                let _ = worker.join();
                return Err("SKILL_MCP_WORKER_FAILED".into());
            }
        };
        Ok(Self {
            state,
            url: format!("http://{address}/mcp"),
            authorization,
            workers: Mutex::new(vec![worker, timer]),
        })
    }
    pub(crate) fn url(&self) -> &str {
        &self.url
    }
    pub(crate) fn authorization(&self) -> &str {
        &self.authorization
    }
    pub(crate) fn close(&self) {
        self.state.close();
        if let Ok(mut workers) = self.workers.lock() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}
impl Drop for NativeSkillMcpBridge {
    fn drop(&mut self) {
        self.close();
    }
}

type Reply = (u16, Option<Value>);
fn error(status: u16, code: &str) -> Reply {
    (status, Some(json!({"error":code})))
}
fn equal_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b)
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}
fn read(
    socket: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
    state: &Lifetime,
) -> Result<usize, Reply> {
    if !state.open() || Instant::now() >= deadline {
        return Err(error(408, "SKILL_MCP_REQUEST_TIMEOUT"));
    }
    let timeout = deadline.saturating_duration_since(Instant::now());
    socket
        .set_read_timeout(Some(timeout))
        .map_err(|_| error(408, "SKILL_MCP_REQUEST_TIMEOUT"))?;
    socket
        .read(buffer)
        .map_err(|_| error(408, "SKILL_MCP_REQUEST_TIMEOUT"))
}
fn handle(socket: &mut TcpStream, host: &str, authorization: &str, state: &Lifetime) -> Reply {
    // Count every accepted connection, including denied or incomplete requests.
    if state.requests.fetch_add(1, Ordering::SeqCst) >= state.max_requests {
        state.close();
        return error(429, "SKILL_MCP_REQUEST_LIMIT");
    }
    let deadline = (Instant::now() + Duration::from_secs(5)).min(state.expires);
    let mut bytes = Vec::new();
    let head_end = loop {
        if let Some(index) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
            if index + 4 > HEADER_BYTES {
                return error(431, "SKILL_MCP_HEADER_LIMIT");
            }
            break index + 4;
        }
        if bytes.len() >= HEADER_BYTES {
            return error(431, "SKILL_MCP_HEADER_LIMIT");
        }
        let mut chunk = [0_u8; 1024];
        match read(socket, &mut chunk, deadline, state) {
            Ok(0) => return error(400, "SKILL_MCP_INVALID_HTTP"),
            Ok(count) => bytes.extend_from_slice(&chunk[..count]),
            Err(reply) => return reply,
        }
    };
    let head = match std::str::from_utf8(&bytes[..head_end - 4]) {
        Ok(head) if !head.contains('\0') => head,
        _ => return error(400, "SKILL_MCP_INVALID_HTTP"),
    };
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut headers = BTreeMap::new();
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            return error(400, "SKILL_MCP_INVALID_HTTP");
        };
        if key.is_empty()
            || key.len() > 128
            || headers.len() >= 64
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || value.contains(['\r', '\n'])
            || headers
                .insert(key.to_ascii_lowercase(), value.trim())
                .is_some()
        {
            return error(400, "SKILL_MCP_INVALID_HTTP");
        }
    }
    if headers.get("host") != Some(&host)
        || headers
            .get("origin")
            .map_or(false, |origin| *origin != format!("http://{host}"))
        || !equal_secret(
            headers.get("authorization").unwrap_or(&"").as_bytes(),
            authorization.as_bytes(),
        )
        || !state.open()
    {
        return error(403, "SKILL_MCP_ACCESS_DENIED");
    }
    if headers
        .get("mcp-protocol-version")
        .map_or(false, |version| !VERSIONS.contains(version))
    {
        return error(400, "SKILL_MCP_UNSUPPORTED_PROTOCOL");
    }
    if first != "POST /mcp HTTP/1.1" {
        return error(405, "SKILL_MCP_METHOD_NOT_ALLOWED");
    }
    if headers.contains_key("transfer-encoding")
        || headers.contains_key("expect")
        || headers
            .get("content-encoding")
            .map_or(false, |v| *v != "identity")
    {
        return error(400, "SKILL_MCP_INVALID_HTTP");
    }
    if !headers.get("content-type").map_or(false, |value| {
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    }) {
        return error(415, "SKILL_MCP_CONTENT_TYPE_REQUIRED");
    }
    let length = match headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        Some(length) if length <= BODY_BYTES => length,
        Some(_) => return error(413, "SKILL_MCP_REQUEST_LIMIT"),
        None => return error(411, "SKILL_MCP_LENGTH_REQUIRED"),
    };
    let mut body = bytes[head_end..].to_vec();
    if body.len() > length {
        return error(400, "SKILL_MCP_INVALID_HTTP");
    }
    while body.len() < length {
        let mut chunk = [0_u8; 8192];
        let remaining = (length - body.len()).min(chunk.len());
        match read(socket, &mut chunk[..remaining], deadline, state) {
            Ok(0) => return error(400, "SKILL_MCP_INVALID_HTTP"),
            Ok(count) => body.extend_from_slice(&chunk[..count]),
            Err(reply) => return reply,
        }
    }
    match serde_json::from_slice::<Value>(&body) {
        Ok(message) => {
            // This flag precedes every service call. A close that won earlier
            // leaves state.open() false; one that loses preserves applied truth.
            state.dispatching.store(true, Ordering::SeqCst);
            rpc(message, state)
        }
        Err(_) => error(400, "SKILL_MCP_INVALID_JSON"),
    }
}
fn object<'a>(
    value: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, ()> {
    let value = value.as_object().ok_or(())?;
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(());
    }
    Ok(value)
}
fn meta(value: Option<&Value>) -> Result<(), ()> {
    if let Some(value) = value {
        if !value.is_object() || value.to_string().len() > 8192 {
            return Err(());
        }
        fn bounded(value: &Value, depth: usize) -> bool {
            if depth > 6 {
                return false;
            }
            match value {
                Value::Object(map) => {
                    map.len() <= 32 && map.values().all(|v| bounded(v, depth + 1))
                }
                Value::Array(values) => {
                    values.len() <= 32 && values.iter().all(|v| bounded(v, depth + 1))
                }
                _ => true,
            }
        }
        if !bounded(value, 0) {
            return Err(());
        }
    }
    Ok(())
}
fn rpc(message: Value, state: &Lifetime) -> Reply {
    let invalid = || error(400, "SKILL_MCP_INVALID_PROTOCOL");
    let message = match object(&message, &["jsonrpc", "id", "method", "params"]) {
        Ok(message) => message,
        Err(_) => return invalid(),
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return invalid();
    }
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return invalid();
    };
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let id = match message.get("id") {
        None => {
            if ["notifications/initialized", "notifications/cancelled"].contains(&method)
                && params.is_object()
            {
                return (202, None);
            }
            return invalid();
        }
        Some(value) if value.is_null() || value.is_string() || value.is_i64() || value.is_u64() => {
            value.clone()
        }
        _ => return invalid(),
    };
    let result = match method {
        "initialize" => {
            if object(
                &params,
                &["protocolVersion", "capabilities", "clientInfo", "_meta"],
            )
            .is_err()
                || meta(params.get("_meta")).is_err()
                || !params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .map_or(false, |version| VERSIONS.contains(&version))
                || !params.get("capabilities").map_or(false, Value::is_object)
                || !params.get("clientInfo").map_or(false, Value::is_object)
            {
                return invalid();
            }
            json!({"protocolVersion":params["protocolVersion"], "capabilities":{"tools":{}},
                "serverInfo":{"name":"ugs-native-scoped-skills","version":"1.0.0"},
                "instructions":"Use skills_list for opaque IDs and host evidence, skill_view for full reads/receipts, and skill_manage for bounded proposals. The host fixes source/workspace/policy. Model claims are not verification; saved scripts are never executed."})
        }
        "ping" | "tools/list" => {
            if object(&params, &["_meta"]).is_err() || meta(params.get("_meta")).is_err() {
                return invalid();
            }
            if method == "ping" {
                json!({})
            } else {
                json!({"tools":tools()})
            }
        }
        "tools/call" => {
            if object(&params, &["name", "arguments", "_meta"]).is_err()
                || meta(params.get("_meta")).is_err()
            {
                return invalid();
            }
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return invalid();
            };
            let result = if state.open() {
                state.invocation.invoke(
                    name,
                    params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                )
            } else {
                Err("SKILL_TOOL_CANCELLED".into())
            };
            #[cfg(test)]
            tests::dispatch_checkpoint(state.invocation.execution_run_id());
            match result {
                Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                Err(error) => {
                    json!({"isError":true,"content":[{"type":"text","text":crate::native_tool_redact_text(&error, 4096)}]})
                }
            }
        }
        _ => {
            return (
                200,
                Some(
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
                ),
            )
        }
    };
    (200, Some(json!({"jsonrpc":"2.0","id":id,"result":result})))
}
fn send(socket: &mut TcpStream, reply: Reply) {
    let (mut status, value) = reply;
    let mut bytes = value
        .map(|value| value.to_string().into_bytes())
        .unwrap_or_default();
    if bytes.len() > RESPONSE_BYTES {
        status = 413;
        bytes = b"{\"error\":\"SKILL_MCP_RESPONSE_LIMIT\"}".to_vec();
    }
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Bad Request",
    };
    let _ = socket.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = write!(socket, "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAllow: POST\r\n\r\n", bytes.len());
    let _ = socket.write_all(&bytes);
}
fn strict(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,"properties":properties,"required":required})
}
fn tools() -> Value {
    let string = json!({"type":"string","minLength":1,"maxLength":100000});
    let operations = vec![
        strict(
            json!({"action":{"const":"create"},"name":string,"content":string}),
            &["action", "name", "content"],
        ),
        strict(
            json!({"action":{"const":"patch"},"skillId":string,"filePath":string,"oldString":string,"newString":{"type":"string","maxLength":100000},"expectedHash":string,"readReceiptId":string}),
            &[
                "action",
                "skillId",
                "oldString",
                "newString",
                "expectedHash",
                "readReceiptId",
            ],
        ),
        strict(
            json!({"action":{"const":"write_file"},"skillId":string,"filePath":string,"content":string,"expectedHash":string,"readReceiptId":string,"absent":{"const":true}}),
            &["action", "skillId", "filePath", "content"],
        ),
        strict(
            json!({"action":{"const":"remove_file"},"skillId":string,"filePath":string,"expectedHash":string,"readReceiptId":string}),
            &[
                "action",
                "skillId",
                "filePath",
                "expectedHash",
                "readReceiptId",
            ],
        ),
    ];
    json!([
        {"name":"skills_list","description":"Discover this host skill catalog and native learning evidence; an index is not a full read.","inputSchema":strict(json!({}),&[]),"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
        {"name":"skill_view","description":"Read complete SKILL.md or support file by opaque ID with fresh receipt. Never executes scripts.","inputSchema":strict(json!({"skillId":string,"filePath":string}),&["skillId"]),"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
        {"name":"skill_manage","description":"Propose bounded skill-only changes with host evidence IDs and exact fresh receipts. Host decides applied/pending/failure; no approval or roots.","inputSchema":strict(json!({"version":{"const":1},"kind":{"const":"propose"},"lesson":string,"evidenceIds":{"type":"array","minItems":1,"maxItems":64,"items":string},"operations":{"type":"array","minItems":1,"maxItems":16,"items":{"anyOf":operations}}}),&["version","kind","lesson","evidenceIds","operations"]),"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}}
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::native_cli::tests::{persisted, request, source};
    use crate::skills::test_support::{skill, Fixture};
    use crate::skills::SkillDesktopHost;
    use std::collections::HashMap;
    use std::sync::OnceLock;

    type DispatchGate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    fn dispatch_gates() -> &'static Mutex<HashMap<String, DispatchGate>> {
        static GATES: OnceLock<Mutex<HashMap<String, DispatchGate>>> = OnceLock::new();
        GATES.get_or_init(|| Mutex::new(HashMap::new()))
    }
    pub(super) fn dispatch_checkpoint(run: &str) {
        let gate = dispatch_gates().lock().unwrap().remove(run);
        if let Some((ready, release)) = gate {
            ready.send(()).unwrap();
            release
                .recv_timeout(Duration::from_secs(5))
                .expect("MCP response delivery release");
        }
    }
    pub(super) fn close_checkpoint(run: &str) {
        dispatch_checkpoint(&format!("close:{run}"));
    }
    fn response_gate(run: &str) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        dispatch_gates()
            .lock()
            .unwrap()
            .insert(run.into(), (ready_tx, release_rx));
        (ready_rx, release_tx)
    }
    fn invocation(f: &Fixture, child: &str) -> Arc<NativeSkillInvocation> {
        let source = source(f);
        persisted(f, &source);
        NativeSkillInvocation::bind(
            Arc::new(SkillDesktopHost::new(f.global())),
            request(&source),
            child,
            source.cwd.as_deref(),
        )
        .unwrap()
    }
    fn call(url: &str, authorization: &str, body: Value) -> String {
        let address = url
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let body = body.to_string();
        let mut socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(socket, "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: {authorization}\r\nMCP-Protocol-Version: 2025-03-26\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut wire = String::new();
        // Preserve partial wire on shutdown; assertions never print credentials.
        let _ = socket.read_to_string(&mut wire);
        wire
    }

    #[test]
    fn actual_mcp_cancel_wakes_incomplete_initialize_and_revokes_before_join() {
        let f = Fixture::new("native-mcp-initialize-cancel");
        let invocation = invocation(&f, "mcp-initialize-cancel-child");
        let bridge = Arc::new(
            NativeSkillMcpBridge::start(Arc::clone(&invocation), 16, Duration::from_secs(30))
                .unwrap(),
        );
        let address = bridge
            .url()
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let (accepted, release) = response_gate("accept:mcp-initialize-cancel-child");
        let mut socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        // A real client begins initialization but withholds the remaining header/body.
        socket.write_all(b"POST /mcp HTTP/1.1\r\nHost: ").unwrap();
        accepted.recv_timeout(Duration::from_secs(5)).expect("actual accepted initialization socket");
        assert!(bridge.state.socket.lock().unwrap().is_some());
        release.send(()).unwrap();
        let started = Instant::now();
        bridge.close();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancel must wake the actual blocked handshake reader and expiry waiter"
        );
        let mut wire = String::new();
        let _ = socket.read_to_string(&mut wire);
        assert!(invocation.invoke("skills_list", json!({})).is_err());
        assert!(
            TcpStream::connect(address).is_err(),
            "listener must be gone after owning finally joins"
        );
        assert!(!f.project().join(".ultragamestudio/skills/.state").exists());
    }

    #[test]
    fn native_mcp_rejects_zero_or_overlong_lifetime_and_expires_real_authority() {
        let f = Fixture::new("native-mcp-lifetime");
        let invocation = invocation(&f, "mcp-lifetime-child");
        for lifetime in [Duration::ZERO, Duration::from_secs(601)] {
            assert!(NativeSkillMcpBridge::start(Arc::clone(&invocation), 16, lifetime).is_err());
        }
        let bridge =
            NativeSkillMcpBridge::start(Arc::clone(&invocation), 16, Duration::from_millis(50))
                .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while invocation.invoke("skills_list", json!({})).is_ok() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            invocation.invoke("skills_list", json!({})).is_err(),
            "expiry must revoke service authority even without a request"
        );
        bridge.close();
    }

    #[test]
    fn actual_mcp_applied_reply_survives_close_after_service_commit() {
        let f = Fixture::new("native-mcp-applied-close");
        let invocation = invocation(&f, "mcp-applied-child");
        let mut starts = HashMap::new();
        let mut sink = |_: &str, mut payload: Value| {
            invocation.observe_native_event(&mut payload).unwrap();
        };
        // Offline native-protocol fixture, not a live provider execution.
        crate::claude_tool_start_patch(
            "mcp-applied-child",
            &json!({}),
            &json!({"id":"mcp-check: exact/a","name":"Bash","input":{"command":"cargo check"}}),
            &mut starts,
            &mut sink,
        );
        crate::claude_tool_result_patch(
            "mcp-applied-child",
            &json!({}),
            &json!({"tool_use_id":"mcp-check: exact/a","content":"offline protocol check","is_error":false,"exit_code":0}),
            &mut starts,
            &mut sink,
        );
        let catalog = invocation.invoke("skills_list", json!({})).unwrap();
        let evidence_id = catalog["learningEvidence"][0]["evidenceId"].clone();
        let content = skill(
            "mcp-applied",
            "Keep the actual host commit outcome after transport cancellation.",
        );
        let bridge = Arc::new(
            NativeSkillMcpBridge::start(Arc::clone(&invocation), 16, Duration::from_secs(30))
                .unwrap(),
        );
        let (ready, release) = response_gate("mcp-applied-child");
        let (close_ready, close_release) = response_gate("close:mcp-applied-child");
        let url = bridge.url().to_owned();
        let auth = bridge.authorization().to_owned();
        let proposal_content = content.clone();
        let client = std::thread::spawn(move || {
            call(
                &url,
                &auth,
                json!({"jsonrpc":"2.0","id":"apply","method":"tools/call","params":{
                    "name":"skill_manage","arguments":{"version":1,"kind":"propose","lesson":"Retain actual commit truth.","evidenceIds":[evidence_id],
                        "operations":[{"action":"create","name":"mcp-applied","content":proposal_content}]}
                }}),
            )
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real host commit before MCP send");
        let closing_bridge = Arc::clone(&bridge);
        let closer = std::thread::spawn(move || closing_bridge.close());
        close_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real close finishes revocation and socket shutdown");
        let closed = bridge.state.closed.load(Ordering::SeqCst);
        release.send(()).unwrap();
        let wire = client.join().unwrap();
        close_release.send(()).unwrap();
        closer.join().unwrap();
        assert!(closed);
        assert_eq!(
            std::fs::read_to_string(
                f.project()
                    .join(".ultragamestudio/skills/mcp-applied/SKILL.md")
            )
            .unwrap(),
            content
        );
        let delivered: Option<Value> = wire
            .split_once("\r\n\r\n")
            .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
            .and_then(|response| {
                response
                    .pointer("/result/content/0/text")
                    .and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str(text).ok())
            });
        assert!(delivered.as_ref().is_some_and(|result| result["status"] == "applied"),
            "a real applied host mutation must be delivered, not lost or replaced by late transport close");
        assert!(invocation.invoke("skills_list", json!({})).is_err());
    }
}
