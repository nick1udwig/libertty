use std::io::{self, BufRead};
use termai_server::protocol::ClientMessage;
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        println!("{}", serde_json::from_str::<ClientMessage>(&line).is_ok());
    }
}
