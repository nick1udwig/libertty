
if [[ -z "$LIBERTTY_NO_RC" && -f "$HOME/.bashrc" ]]; then source "$HOME/.bashrc"; fi
set +o history
HISTSIZE=5000
if [[ -f "$LIBERTTY_HISTORY_SOURCE" ]]; then history -r "$LIBERTTY_HISTORY_SOURCE"; fi
export LIBERTTY_REAL_HISTFILE="$HISTFILE"
HISTFILE=/dev/null
HISTCONTROL=ignorespace:ignoredups
set -o emacs
bind 'set enable-bracketed-paste on'
bind 'set enable-active-region off'
__libertty_input_line() {
  printf '\033]777;libertty;%s;input-line;%s;%s\007' "$LIBERTTY_NONCE" "$(printf '%s' "${READLINE_LINE:0:READLINE_POINT}" | command base64)" "$(printf '%s' "$READLINE_LINE" | command base64)"
}
bind -x '"\C-x\C-r":__libertty_input_line'
__libertty_prompt() {
  local libertty_status=$?
  local libertty_functions="$(builtin compgen -A function)" libertty_aliases="$(builtin compgen -A alias)"
  local libertty_refresh=0 libertty_dir
  if [[ "$PATH" != "$__libertty_catalog_path" || "$PWD" != "$__libertty_catalog_cwd" || "$libertty_functions" != "$__libertty_catalog_functions" || "$libertty_aliases" != "$__libertty_catalog_aliases" || $((SECONDS - __libertty_catalog_at)) -ge 2 ]]; then
    libertty_refresh=1
  else
    local IFS=:
    for libertty_dir in $PATH; do
      if [[ "${libertty_dir:-.}" -nt "$LIBERTTY_COMMANDS_FILE" ]]; then libertty_refresh=1; break; fi
    done
  fi
  if ((libertty_refresh)); then
    builtin compgen -c > "$LIBERTTY_COMMANDS_FILE"
    printf '%s\n' "$libertty_functions" > "$LIBERTTY_FUNCTIONS_FILE"
    __libertty_catalog_path="$PATH" __libertty_catalog_cwd="$PWD" __libertty_catalog_functions="$libertty_functions" __libertty_catalog_aliases="$libertty_aliases" __libertty_catalog_at=$SECONDS
  fi
  while IFS= read -r libertty_env_name; do
    builtin printf '%s=%s\0' "$libertty_env_name" "${!libertty_env_name}"
  done < <(builtin compgen -e) > "$LIBERTTY_ENV_FILE"

  {
    builtin declare -f
    builtin complete -p
    local libertty_completion_var
    while IFS= read -r libertty_completion_var; do
      case "$libertty_completion_var" in
        _*|*COMPLETION*|COMP_WORDBREAKS)
          builtin declare -p "$libertty_completion_var" 2>/dev/null ;;
      esac
    done < <(builtin compgen -A variable)
  } > "$LIBERTTY_COMPLETIONS_FILE.tmp"
  command mv -f -- "$LIBERTTY_COMPLETIONS_FILE.tmp" "$LIBERTTY_COMPLETIONS_FILE"

  # Remote programs may leave the cursor above old output. Clear the unused area
  # before drawing our next prompt, without erasing output above or scrollback.
  printf '\033[J\033]777;libertty;%s;prompt;%s;%s\007' "$LIBERTTY_NONCE" "$libertty_status" "$(printf '%s\0%s' "$PWD" "$(HISTTIMEFORMAT= builtin history 1)" | command base64)"
}

__libertty_capture_herdr() {
  local libertty_pattern='^[[:space:]]*((/[^[:space:]]*/)?herdr)([[:space:]]+--session[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}|[[:space:]]+session[[:space:]]+attach[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?[[:space:]]*$'
  [[ "$READLINE_LINE" =~ $libertty_pattern ]] || return 1
  local libertty_binary; read -r libertty_binary _ <<< "$READLINE_LINE"
  [[ "$(builtin type -t "$libertty_binary")" == file ]] || return 1
  [[ "$READLINE_LINE" == [[:space:]]* ]] || builtin history -s "$READLINE_LINE"
  printf '\r\n\033]777;libertty;%s;herdr;%s\007' "$LIBERTTY_NONCE" "$(printf '%s' "$READLINE_LINE" | command base64)"
  READLINE_LINE= READLINE_POINT=0
}


__libertty_ssh_passthrough() {
  local libertty_definition libertty_line libertty_names=' ' libertty_name libertty_row=0
  libertty_definition="$(builtin declare -f ssh)" || return 1
  while IFS=$' \t' read -r libertty_line; do
    ((libertty_row+=1))
    if ((libertty_row == 1)); then [[ "$libertty_line" == 'ssh ()' ]] || return 1; continue; fi
    if ((libertty_row == 2)); then [[ "$libertty_line" == '{' ]] || return 1; continue; fi
    libertty_line="${libertty_line%;}"
    if [[ "$libertty_line" == 'command ssh "$@"' || "$libertty_line" == '/usr/bin/ssh "$@"' || "$libertty_line" == '/bin/ssh "$@"' ]]; then
      return 0
    elif [[ "$libertty_line" =~ ^local[[:space:]]+([a-z_][a-z_0-9[:space:]]*)$ ]]; then
      for libertty_name in ${BASH_REMATCH[1]}; do
        [[ "$libertty_name" =~ ^[a-z_][a-z_0-9]*$ && "$libertty_name" != libertty_* ]] || return 1
        libertty_names+="$libertty_name "
      done
    elif [[ "$libertty_line" =~ ^([a-z_][a-z_0-9]*)=\$(SECONDS|\?)$ ]]; then
      [[ "$libertty_names" == *" ${BASH_REMATCH[1]} "* ]] || return 1
    else
      return 1
    fi
  done <<< "$libertty_definition"
  return 1
}


builtin unalias upload download 2>/dev/null || :
function upload {
  if (( $# > 1 )); then printf '%s\n' 'Usage: upload [DIRECTORY]' >&2; return 2; fi
  local libertty_destination="${1:-$PWD}"
  [[ "$libertty_destination" == /* ]] || libertty_destination="$PWD/$libertty_destination"
  if [[ ! -d "$libertty_destination" ]]; then printf '%s\n' 'Upload destination is not a directory.' >&2; return 1; fi
  printf '\033]777;libertty;%s;transfer-upload;%s\007' "$LIBERTTY_NONCE" "$(printf '%s' "$libertty_destination" | command base64)" > /dev/tty
}
function download { (
  local libertty_file libertty_name libertty_size libertty_mode=auto
  if [[ "${1-}" == --file ]]; then libertty_mode=file; shift; fi
  if [[ "${1-}" == -- ]]; then shift; fi
  if (( $# > 1 )); then printf '%s\n' 'Usage: download FILE  OR  command | download [NAME]' >&2; return 2; fi
  if [[ -t 0 || "$libertty_mode" == file ]]; then
    if (( $# != 1 )) || [[ ! -f "$1" ]]; then printf '%s\n' 'Usage: download FILE  OR  command | download [NAME]' >&2; return 2; fi
    libertty_file="$1"; [[ "$libertty_file" == /* ]] || libertty_file="$PWD/$libertty_file"
    printf '\033]777;libertty;%s;transfer-download;%s\007' "$LIBERTTY_NONCE" "$(printf '%s' "$libertty_file" | command base64)" > /dev/tty
    return
  fi
  libertty_name="${1:-command-output.txt}"
  if [[ "$libertty_name" == */* || "$libertty_name" == *\\* || "$libertty_name" =~ [[:cntrl:]] || "$libertty_name" == '.' || "$libertty_name" == '..' || ${#libertty_name} -gt 255 ]]; then printf '%s\n' 'Use a filename for the downloaded output.' >&2; return 2; fi
  libertty_file="$(command mktemp "$LIBERTTY_TRANSFER_DIR/download.XXXXXXXX")" || return
  trap 'command rm -f -- "$libertty_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  command head -c 1073741825 > "$libertty_file" || return
  libertty_size="$(command wc -c < "$libertty_file")" || return
  if (( libertty_size > 1073741824 )); then printf '%s\n' 'Piped downloads are limited to 1 GB.' >&2; return 1; fi
  printf '\033]777;libertty;%s;transfer-capture;%s;%s\007' "$LIBERTTY_NONCE" "${libertty_file##*/}" "$(printf '%s' "$libertty_name" | command base64)" > /dev/tty || return
  trap - EXIT
); }


__libertty_read() (
  local libertty_mode=auto libertty_target libertty_file libertty_code=0 libertty_size
  case "${1-}" in
    --file) libertty_mode=file; shift ;;
    --command) libertty_mode=command; shift ;;
    --) shift ;;
  esac
  libertty_target="$(IFS=' '; printf '%s' "$*")"
  if (( $# )) && [[ "$libertty_mode" != command ]] && {
    [[ -e "$libertty_target" || "$libertty_mode" == file ]] || ! builtin type -t -- "$1" >/dev/null;
  }; then
    [[ "$libertty_target" == /* ]] || libertty_target="$PWD/$libertty_target"
    printf '\033]777;libertty;%s;reading-file;%s\007' "$LIBERTTY_NONCE" "$(printf '%s' "$libertty_target" | command base64)" > /dev/tty
    return
  fi
  if (( $# == 0 )) && [[ -t 0 ]]; then
    printf '%s\n' 'Usage: command | look at  OR  look at FILE  OR  look at COMMAND [ARGS…]' >&2
    return 2
  fi
  libertty_file="$(command mktemp "$LIBERTTY_READING_DIR/read.XXXXXXXX")" || return
  trap 'command rm -f -- "$libertty_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if (( $# )); then
    if "$@" | command head -c 20971521 > "$libertty_file"; then
      libertty_code=${PIPESTATUS[0]}
    else
      libertty_code=${PIPESTATUS[0]}
    fi
  else
    command head -c 20971521 > "$libertty_file" || return
    libertty_target='Command output'
  fi
  libertty_size="$(command wc -c < "$libertty_file")" || return
  if (( libertty_size > 20971520 )); then
    printf '%s\n' 'Reading Mode output exceeds the 20 MB limit.' >&2
    return 1
  fi
  printf '\033]777;libertty;%s;reading-capture;%s;%s;%s\007' "$LIBERTTY_NONCE" "${libertty_file##*/}" "$(printf '%s' "$libertty_target" | command base64)" "$libertty_code" > /dev/tty || return
  trap - EXIT
  return "$libertty_code"
)
# The utility is session-local; other uses of the system look command still work.
builtin unalias look 2>/dev/null || :
function look {
  if [[ "${1-}" == at ]]; then shift; __libertty_read "$@"; else command look "$@"; fi
}


__libertty_history_segment() {
  [[ "$1" =~ ^[[:space:]]*(upload|download|__libertty_read)([[:space:]]|$) ||
     "$1" =~ ^[[:space:]]*look[[:space:]]+at([[:space:]]|$) ]]
}
__libertty_history_special() {
  local libertty_line="$1" libertty_segment= libertty_quote= libertty_char
  local libertty_at libertty_depth=0 libertty_escape=0
  for ((libertty_at=0; libertty_at<${#libertty_line}; libertty_at++)); do
    libertty_char="${libertty_line:libertty_at:1}"
    if ((libertty_escape)); then
      libertty_segment+="$libertty_char"; libertty_escape=0; continue
    fi
    if [[ "$libertty_char" == '\' && "$libertty_quote" != "'" ]]; then
      libertty_segment+="$libertty_char"; libertty_escape=1; continue
    fi
    if [[ -n "$libertty_quote" ]]; then
      [[ "$libertty_char" != "$libertty_quote" ]] || libertty_quote=
      libertty_segment+="$libertty_char"; continue
    fi
    case "$libertty_char" in
      "'"|'"'|'`') libertty_quote="$libertty_char"; libertty_segment+="$libertty_char" ;;
      '('|'{') libertty_depth=$((libertty_depth + 1)); libertty_segment+="$libertty_char" ;;
      ')'|'}') libertty_depth=$((libertty_depth - 1)); libertty_segment+="$libertty_char" ;;
      '|'|';'|'&')
        if ((libertty_depth == 0)); then
          if __libertty_history_segment "$libertty_segment"; then return 0; fi
          libertty_segment=
        else libertty_segment+="$libertty_char"; fi ;;
      '#')
        if ((libertty_depth == 0)) && [[ -z "$libertty_segment" || "$libertty_segment" == *[[:space:]] ]]; then break; fi
        libertty_segment+="$libertty_char" ;;
      *) libertty_segment+="$libertty_char" ;;
    esac
  done
  __libertty_history_segment "$libertty_segment"
}

# Readline owns history, completion and pasted text. Inspect its final buffer,
# prefix managed utilities for ignorespace and divert local SSH connections.
__libertty_accept() {
  if [[ "$READLINE_LINE" != ' '* ]] && __libertty_history_special "$READLINE_LINE"; then
    READLINE_LINE=" $READLINE_LINE"
    READLINE_POINT=$((READLINE_POINT + 1))
  fi
  if __libertty_capture_herdr; then return; fi
  if [[ "$LIBERTTY_CAPTURE_SSH" == 1 && "$READLINE_LINE" =~ ^[[:space:]]*(ssh|/usr/bin/ssh)[[:space:]] && ! "$READLINE_LINE" =~ [[:cntrl:]] && ${#READLINE_LINE} -le 4000 ]]; then
    # Preserve custom SSH behavior, but allow wrappers that immediately forward
    # the same arguments (such as reconnect/terminal-cleanup wrappers).
    if [[ "$READLINE_LINE" =~ ^[[:space:]]*ssh[[:space:]] ]]; then
      local libertty_kind="$(builtin type -t ssh)"
      if [[ "$libertty_kind" == function ]]; then
        __libertty_ssh_passthrough || return
      elif [[ "$libertty_kind" != file ]]; then
        return
      fi
      local libertty_ssh="$(builtin type -P ssh)"
      [[ "$libertty_ssh" == /usr/bin/ssh || "$libertty_ssh" == /bin/ssh ]] || return
    fi
    [[ "$READLINE_LINE" == [[:space:]]* ]] || builtin history -s "$READLINE_LINE"
    printf '\r\n\033]777;libertty;%s;ssh;%s\007' "$LIBERTTY_NONCE" "$(printf '%s' "$READLINE_LINE" | command base64)"
    READLINE_LINE= READLINE_POINT=0
  fi
}
bind -x '"\C-x\C-t":__libertty_accept'
bind '"\C-m":"\C-x\C-t\C-j"'
PROMPT_COMMAND=(__libertty_prompt)
PS0=$'\033]777;libertty;'"$LIBERTTY_NONCE"$';busy\007'
PS1='\[\e[38;5;114m\]\w\[\e[0m\] $ '
set -o history
