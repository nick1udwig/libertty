use crate::{
    shell_structure::{Separator, command_list},
    speech::expand_symbols,
};

pub fn pipeline_parts(input: &str) -> Option<Vec<String>> {
    let expanded = expand_symbols(input, true);
    let list = command_list(&expanded)?;
    list.separators
        .iter()
        .all(|separator| *separator == Separator::Pipe)
        .then(|| list.commands.into_iter().map(str::to_owned).collect())
}
