//! An authenticated gateway to the loopback-only frontend development tool.
use axum::{
    body::Body,
    extract::{
        FromRequestParts,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{Method, Request, Response, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

type Failure = (StatusCode, String);
fn unavailable() -> Failure {
    (
        StatusCode::BAD_GATEWAY,
        "Frontend development server is unavailable.".into(),
    )
}
pub fn origin(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid TERMAI_DEV_FRONTEND.")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("TERMAI_DEV_FRONTEND must be a loopback HTTP origin with a port.".into());
    }
    Ok(value.trim_end_matches('/').into())
}
pub async fn serve(
    origin: &str,
    base: &str,
    pathname: &str,
    paired: bool,
    same_origin: bool,
    req: Request<Body>,
) -> Result<Response<Body>, Failure> {
    if !paired {
        if req.headers().contains_key("upgrade") {
            return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
        }
        if *req.method() == Method::GET
            && ["/", "/index.html", "/terminal.html"].contains(&pathname)
        {
            return Ok(Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .header("cache-control", "no-store")
                .body(Body::from(
                    include_str!("../assets/pairing.html").replace("__TERMAI_PUBLIC_BASE__", base),
                ))
                .unwrap());
        }
        return Err((
            StatusCode::UNAUTHORIZED,
            "Pair with this backend first.".into(),
        ));
    }
    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let target = format!("{origin}{}{pathname}{query}", base.trim_end_matches('/'));
    if req
        .headers()
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        if !same_origin {
            return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
        }
        let mut upstream = target
            .replacen("http://", "ws://", 1)
            .into_client_request()
            .map_err(|_| unavailable())?;
        if let Some(protocol) = req.headers().get("sec-websocket-protocol") {
            upstream
                .headers_mut()
                .insert("sec-websocket-protocol", protocol.clone());
        }
        let (mut parts, _) = req.into_parts();
        let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &())
            .await
            .map_err(|_| unavailable())?;
        return Ok(upgrade
            .protocols(["vite-hmr"])
            .max_message_size(8 * 1024 * 1024)
            .on_upgrade(move |socket| bridge(socket, upstream))
            .into_response());
    }
    if ![Method::GET, Method::HEAD].contains(req.method()) {
        return Err((StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.".into()));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| unavailable())?;
    let mut headers = req.headers().clone();
    for name in [
        "host",
        "connection",
        "authorization",
        "cookie",
        "content-length",
        "upgrade",
    ] {
        headers.remove(name);
    }
    let response = client
        .request(req.method().clone(), target)
        .headers(headers)
        .send()
        .await
        .map_err(|_| unavailable())?;
    let mut builder = Response::builder().status(response.status());
    for (name, value) in response.headers() {
        if !["connection", "transfer-encoding"].contains(&name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    Ok(builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap())
}
async fn bridge(mut browser: WebSocket, upstream: tungstenite::http::Request<()>) {
    let Ok(Ok((mut tool, _))) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(upstream),
    )
    .await
    else {
        return;
    };
    loop {
        tokio::select! {
            message = browser.next() => {
                let Some(Ok(message)) = message else { break };
                let message = match message {
                    Message::Text(v) => tungstenite::Message::Text(v.to_string().into()),
                    Message::Binary(v) => tungstenite::Message::Binary(v),
                    Message::Ping(v) => tungstenite::Message::Ping(v),
                    Message::Pong(v) => tungstenite::Message::Pong(v),
                    Message::Close(_) => break,
                };
                if !matches!(tokio::time::timeout(Duration::from_secs(5), tool.send(message)).await, Ok(Ok(()))) { break; }
            }
            message = tool.next() => {
                let Some(Ok(message)) = message else { break };
                let message = match message {
                    tungstenite::Message::Text(v) => Message::Text(v.to_string().into()),
                    tungstenite::Message::Binary(v) => Message::Binary(v),
                    tungstenite::Message::Ping(v) => Message::Ping(v),
                    tungstenite::Message::Pong(v) => Message::Pong(v),
                    tungstenite::Message::Close(v) => Message::Close(v.map(|v| CloseFrame { code: v.code.into(), reason: v.reason.to_string().into() })),
                    tungstenite::Message::Frame(_) => continue,
                };
                let closed = matches!(message, Message::Close(_));
                if !matches!(tokio::time::timeout(Duration::from_secs(5), browser.send(message)).await, Ok(Ok(()))) || closed { break; }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), tool.close(None)).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), browser.close()).await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn frontend_origin_is_only_an_uncredentialed_loopback_service() {
        assert_eq!(
            super::origin("http://127.0.0.1:1234/"),
            Ok("http://127.0.0.1:1234".into())
        );
        for value in [
            "http://example.com:1234",
            "https://127.0.0.1:1234",
            "http://127.0.0.1",
            "http://user@127.0.0.1:1234",
            "http://127.0.0.1:1234/path",
            "http://127.0.0.1:1234/?token=x",
        ] {
            assert!(super::origin(value).is_err());
        }
    }
}
