// Offline stdio/MCP fixture: uses only local files and host loopback HTTP.
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn string_field<'a>(text: &'a str, key: &str) -> &'a str {
    let marker = format!("\"{key}\":\"");
    let rest = text.split_once(&marker).expect("fixture field missing").1;
    rest.split_once('"').unwrap().0
}
fn call(url: &str, authorization: &str, body: &str) -> String {
    let address = url
        .strip_prefix("http://")
        .unwrap()
        .strip_suffix("/mcp")
        .unwrap();
    let mut socket = TcpStream::connect(address).expect("fixture loopback connection");
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(socket, "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: {authorization}\r\nMCP-Protocol-Version: 2025-03-26\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut reply = String::new();
    socket.read_to_string(&mut reply).unwrap();
    assert!(
        reply.starts_with("HTTP/1.1 200"),
        "fixture MCP request denied"
    );
    reply.split_once("\r\n\r\n").unwrap().1.to_owned()
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--help") {
        println!("fixture app server --stdio --input-format stream-json --output-format stream-json --mcp-config");
        return;
    }
    if args.iter().any(|arg| arg == "app-server") {
        std::fs::write("native-transport-started", "offline codex fixture").unwrap();
        for line in std::io::stdin().lock().lines() {
            let line = line.unwrap();
            if line.contains("\"method\":\"initialize\"") {
                println!("{}", r#"{"id":"ugs-init","result":{}}"#);
            } else if line.contains("\"method\":\"thread/start\"") {
                println!(
                    "{}",
                    r#"{"id":"ugs-thread-start","result":{"thread":{"id":"fixture-thread"}}}"#
                );
            } else if line.contains("\"method\":\"turn/start\"") {
                println!(
                    "{}",
                    r#"{"id":"ugs-turn-start","result":{"turn":{"id":"fixture-turn","status":"inProgress"}}}"#
                );
                println!(
                    "{}",
                    r#"{"method":"item/started","params":{"item":{"id":"fixture-codex-tail: exact/a","type":"commandExecution","command":"fixture-check","status":"inProgress"}}}"#
                );
                println!(
                    "{}",
                    r#"{"method":"item/agentMessage/delta","params":{"itemId":"fixture-answer","delta":"offline codex complete"}}"#
                );
                println!(
                    "{}",
                    r#"{"method":"turn/completed","params":{"turn":{"id":"fixture-turn","status":"completed"}}}"#
                );
                println!(
                    "{}",
                    r#"{"method":"item/completed","params":{"item":{"id":"fixture-codex-tail: exact/a","type":"commandExecution","command":"fixture-check","status":"completed","exitCode":0,"aggregatedOutput":"offline fixture check"}}}"#
                );
                std::io::stdout().flush().unwrap();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            std::io::stdout().flush().unwrap();
        }
        return;
    }
    std::fs::write("native-transport-started", "offline fixture").unwrap();
    let config_path = args
        .windows(2)
        .find(|pair| pair[0] == "--mcp-config")
        .map(|pair| &pair[1]);
    if std::env::var("UGS_NATIVE_FIXTURE_MODE").as_deref() == Ok("ordinary") {
        assert!(
            config_path.is_none(),
            "off or unsupported runs must not receive scoped MCP config"
        );
        println!(
            "{}",
            r#"{"type":"result","result":"ordinary native complete"}"#
        );
        std::io::stdout().flush().unwrap();
        return;
    }
    let Some(config_path) = config_path else {
        eprintln!("fixture missing controlled MCP config");
        std::process::exit(21);
    };
    let config = std::fs::read_to_string(config_path).unwrap();
    let skill = config
        .split_once("\"ugs_skills\":")
        .expect("fixture scope missing")
        .1;
    let url = string_field(skill, "url");
    let authorization = string_field(skill, "Authorization");
    // Only nonsecret path and actual RPC response are retained for assertions.
    std::fs::write("native-config-path.txt", config_path).unwrap();
    call(
        url,
        authorization,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"offline-stdio-fixture","version":"1"}}}"#,
    );
    let catalog = call(
        url,
        authorization,
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skills_list","arguments":{},"_meta":{"claudecode/toolUseId":"inert-fixture"}}}"#,
    );
    assert!(
        !catalog.contains("\"isError\":true"),
        "fixture catalog denied"
    );
    std::fs::write("native-mcp-list-response.json", catalog).unwrap();
    if std::env::var("UGS_NATIVE_FIXTURE_MODE").as_deref() == Ok("invalid-linger") {
        std::io::stdout().write_all(&[0xff, b'\n']).unwrap();
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if std::env::var("UGS_NATIVE_FIXTURE_MODE").as_deref() == Ok("failed-terminal-linger") {
        println!(
            "{}",
            r#"{"type":"result","is_error":true,"subtype":"error_during_execution","result":"offline terminal failure"}"#
        );
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if std::env::var("UGS_NATIVE_FIXTURE_MODE").as_deref() == Ok("nonzero") {
        std::process::exit(23);
    }
    for line in std::io::stdin().lock().lines() {
        let _ = line.unwrap();
        println!(
            "{}",
            r#"{"type":"assistant","parent_tool_use_id":"fixture-parent: exact/b","message":{"content":[{"type":"tool_use","id":"fixture-native: exact/a","name":"Read","input":{"path":"native-transport-started"}}]}}"#
        );
        let text = std::fs::read_to_string("native-transport-started").unwrap();
        assert_eq!(text, "offline fixture");
        println!(
            "{}",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"fixture-native: exact/a","is_error":false,"content":"offline fixture"}]}}"#
        );
        println!(
            "{}",
            r#"{"type":"result","result":"offline native complete","usage":{"input_tokens":7,"output_tokens":3}}"#
        );
        std::io::stdout().flush().unwrap();
        break;
    }
}
