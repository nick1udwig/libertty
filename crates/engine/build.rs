use std::{collections::BTreeSet, path::PathBuf};
use syn::visit::{self, Visit};

#[derive(Default)]
struct Patterns(BTreeSet<String>);
impl<'ast> Visit<'ast> for Patterns {
    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(function) = call.func.as_ref()
            && function.path.segments.last().is_some_and(|name| {
                ["regex", "test", "replace"]
                    .iter()
                    .any(|expected| name.ident == expected)
            })
            && let Some(syn::Expr::Lit(argument)) = call.args.first()
            && let syn::Lit::Str(pattern) = &argument.lit
        {
            self.0.insert(pattern.value());
        }
        visit::visit_expr_call(self, call);
    }
}
fn main() {
    let mut patterns = Patterns::default();
    for entry in std::fs::read_dir("src").unwrap() {
        let file = entry.unwrap().path();
        if file.extension().is_some_and(|extension| extension == "rs") {
            println!("cargo:rerun-if-changed={}", file.display());
            patterns.visit_file(&syn::parse_file(&std::fs::read_to_string(file).unwrap()).unwrap());
        }
    }
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("patterns.rs");
    let patterns = patterns.0.into_iter().collect::<Vec<_>>();
    let mut source = format!(
        "pub const PATTERNS: &[&str] = &{patterns:?};\n#[inline(always)]\npub fn compiled(pattern: &str) -> Option<&'static std::sync::Arc<regex::Regex>> {{ match pattern {{\n"
    );
    for pattern in patterns {
        source.push_str(&format!("{pattern:?} => {{ static CACHE: std::sync::OnceLock<std::sync::Arc<regex::Regex>> = std::sync::OnceLock::new(); Some(CACHE.get_or_init(|| std::sync::Arc::new(super::compile({pattern:?})))) }},\n"));
    }
    source.push_str("_ => None, } }\n");
    std::fs::write(output, source).unwrap();
}
