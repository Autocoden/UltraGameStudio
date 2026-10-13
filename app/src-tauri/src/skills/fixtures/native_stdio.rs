//! Deterministic local protocol fixture, not a model/provider or installed CLI.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

fn string(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let tail = text.split_once(&needle)?.1.trim_start().strip_prefix('"')?;
    let mut output = String::new();
    let mut escaped = false;
    for c in tail.chars() {
        if escaped {
            output.push(match c { 'n' => '\n', 'r' => '\r', 't' => '\t', other => other });
            escaped = false;
        } else if c == '\\' { escaped = true; }
        else if c == '"' { return Some(output); }
        else { output.push(c); }
    }
    None
}
fn call(url: &str, auth: &str, name: &str, arguments: &str) -> String {
    let address = url.strip_prefix("http://").unwrap().strip_suffix("/mcp").unwrap();
    let body = format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{{\"name\":\"{name}\",\"arguments\":{arguments},\"_meta\":{{\"claudecode/toolUseId\":\"inert-fixture\"}}}}}}");
    let mut socket = TcpStream::connect(address).expect("fixture MCP connection");
    socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(socket, "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: {auth}\r\nmcp-protocol-version: 2025-03-26\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut wire = String::new();
    socket.read_to_string(&mut wire).unwrap();
    assert!(wire.starts_with("HTTP/1.1 200"), "fixture MCP status");
    let payload = wire.split_once("\r\n\r\n").unwrap().1;
    assert!(!payload.contains("\"isError\":true"), "fixture MCP tool failed");
    string(payload, "text").expect("fixture tool JSON response")
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--help") {
        println!("--mcp-config --strict-mcp-config --allowed-tools");
        return;
    }
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    std::fs::write("native-fixture-started", "deterministic local protocol").unwrap();
    let Some(config) = args.windows(2).find(|pair| pair[0] == "--mcp-config").map(|pair| pair[1].clone()) else {
        eprintln!("fixture requires invocation-scoped MCP config");
        std::process::exit(65);
    };
    std::fs::write("native-config-path.txt", &config).unwrap();
    let config = std::fs::read_to_string(Path::new(&config)).unwrap();
    let url = string(&config, "url").unwrap();
    let auth = string(&config, "Authorization").unwrap();
    println!(r#"{{"type":"assistant","parent_tool_use_id":"parent: original/fixture","message":{{"content":[{{"type":"tool_use","id":"tool: native/list","name":"mcp__ugs_skills__skills_list","input":{{}}}}]}}}}"#);
    std::io::stdout().flush().unwrap();
    let catalog = call(&url, &auth, "skills_list", "{}");
    std::fs::write("native-catalog.json", &catalog).unwrap();
    println!(r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"tool: native/list","content":"actual local catalog received","is_error":false}}]}}}}"#);
    let id = string(&catalog, "skillId").expect("fixture catalog entry");
    let read = call(&url, &auth, "skill_view", &format!("{{\"skillId\":\"{id}\"}}"));
    std::fs::write("native-view.json", &read).unwrap();
    println!(r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","id":"tool: native/view","name":"mcp__ugs_skills__skill_view","input":{{}}}}]}}}}"#);
    println!(r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"tool: native/view","content":"actual complete host read received","is_error":false}}]}}}}"#);
    println!(r#"{{"type":"result","subtype":"success","result":"deterministic native fixture completed","is_error":false}}"#);
}
