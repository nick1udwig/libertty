use axum::{
    body::Body,
    http::{HeaderMap, Method, Response, StatusCode},
};
use std::{
    collections::HashMap,
    path::{Component, Path},
};
use tokio_util::io::ReaderStream;

pub fn accepted_encodings(header: Option<&str>) -> Vec<&'static str> {
    let Some(header) = header else {
        return vec!["identity"];
    };
    let mut values = HashMap::new();
    for part in header.split(',') {
        let lower = part.to_lowercase();
        let mut parameters = lower.split(';');
        let name = parameters.next().unwrap_or("").trim();
        let quality = parameters
            .find_map(|p| p.trim().strip_prefix("q="))
            .map_or(1.0, |q| {
                q.parse::<f64>()
                    .unwrap_or(if q.is_empty() { 0.0 } else { f64::NAN })
            });
        values.insert(
            name.to_owned(),
            if (0.0..=1.0).contains(&quality) {
                quality
            } else {
                0.0
            },
        );
    }
    let mut result = ["br", "gzip", "identity"]
        .map(|name| {
            let default = if name == "identity" {
                if values.get("*") == Some(&0.0) {
                    0.0
                } else {
                    1.0
                }
            } else {
                *values.get("*").unwrap_or(&0.0)
            };
            (name, *values.get(name).unwrap_or(&default))
        })
        .into_iter()
        .filter(|(_, q)| *q > 0.0)
        .collect::<Vec<_>>();
    result.sort_by(|a, b| b.1.total_cmp(&a.1));
    result.into_iter().map(|(name, _)| name).collect()
}

pub async fn serve(
    dist: &Path,
    base: &str,
    pathname: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Response<Body> {
    let empty = |status| {
        Response::builder()
            .status(status)
            .body(Body::empty())
            .unwrap()
    };
    if !matches!(*method, Method::GET | Method::HEAD) {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let decoded = match percent_encoding::percent_decode_str(if pathname == "/" {
        "/index.html"
    } else {
        pathname
    })
    .decode_utf8()
    {
        Ok(path) => path,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    // Normalize without allowing a decoded parent component to escape the distribution root.
    let mut relative = std::path::PathBuf::new();
    for part in Path::new(decoded.as_ref()).components() {
        match part {
            Component::Normal(name) => relative.push(name),
            Component::ParentDir => {
                if !relative.pop() {
                    return empty(StatusCode::FORBIDDEN);
                }
            }
            Component::RootDir | Component::CurDir => {}
            Component::Prefix(_) => return empty(StatusCode::FORBIDDEN),
        }
    }
    if relative.as_os_str().is_empty() {
        return empty(StatusCode::FORBIDDEN);
    }
    let file = dist.join(relative);
    let info = match tokio::fs::metadata(&file).await {
        Ok(info) if info.is_file() => info,
        _ => {
            return Response::builder()
                .status(404)
                .body(Body::from("Not found"))
                .unwrap();
        }
    };
    let extension = file.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    let html = extension == "html";
    let mut selected = None;
    for encoding in accepted_encodings(headers.get("accept-encoding").and_then(|h| h.to_str().ok()))
    {
        if encoding == "identity" {
            selected = Some((file.clone(), encoding, info.len()));
            break;
        }
        if html {
            continue;
        }
        let variant = std::path::PathBuf::from(format!(
            "{}{}",
            file.display(),
            if encoding == "br" { ".br" } else { ".gz" }
        ));
        if let Ok(info) = tokio::fs::metadata(&variant).await
            && info.is_file()
        {
            selected = Some((variant, encoding, info.len()));
            break;
        }
    }
    let Some((selected, encoding, size)) = selected else {
        return empty(StatusCode::NOT_ACCEPTABLE);
    };
    let mime = match extension {
        "html" => "text/html",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    };
    let mut response = Response::builder()
        .header("vary", "Accept-Encoding")
        .header("content-type", mime)
        .header(
            "cache-control",
            if pathname.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        );
    if encoding != "identity" {
        response = response.header("content-encoding", encoding)
    }
    if !html {
        response = response.header("content-length", size)
    }
    let body = if *method == Method::HEAD {
        Body::empty()
    } else if html {
        match tokio::fs::read_to_string(selected).await {
            Ok(text) => Body::from(text.replacen(
                "<base href=\"/\" data-termai-base>",
                &format!("<base href=\"{base}\" data-termai-base>"),
                1,
            )),
            Err(_) => return empty(StatusCode::NOT_FOUND),
        }
    } else {
        match tokio::fs::File::open(selected).await {
            Ok(file) => Body::from_stream(ReaderStream::new(file)),
            Err(_) => return empty(StatusCode::NOT_FOUND),
        }
    };
    response.body(body).unwrap()
}
