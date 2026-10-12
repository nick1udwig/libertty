
if [[ -z "$TERMAI_NO_RC" && -f "$HOME/.bashrc" ]]; then source "$HOME/.bashrc"; fi
set +o history
HISTSIZE=5000
if [[ -f "$TERMAI_HISTORY_SOURCE" ]]; then history -r "$TERMAI_HISTORY_SOURCE"; fi
export TERMAI_REAL_HISTFILE="$HISTFILE"
HISTFILE=/dev/null
HISTCONTROL=ignorespace:ignoredups
set -o emacs
bind 'set enable-bracketed-paste on'
bind 'set enable-active-region off'
__termai_input_line() {
  printf '\033]777;termai;%s;input-line;%s;%s\007' "$TERMAI_NONCE" "$(printf '%s' "${READLINE_LINE:0:READLINE_POINT}" | command base64)" "$(printf '%s' "$READLINE_LINE" | command base64)"
}
bind -x '"\C-x\C-r":__termai_input_line'
__termai_prompt() {
  local termai_status=$?
  local termai_functions="$(builtin compgen -A function)" termai_aliases="$(builtin compgen -A alias)"
  local termai_refresh=0 termai_dir
  if [[ "$PATH" != "$__termai_catalog_path" || "$PWD" != "$__termai_catalog_cwd" || "$termai_functions" != "$__termai_catalog_functions" || "$termai_aliases" != "$__termai_catalog_aliases" || $((SECONDS - __termai_catalog_at)) -ge 2 ]]; then
    termai_refresh=1
  else
    local IFS=:
    for termai_dir in $PATH; do
      if [[ "${termai_dir:-.}" -nt "$TERMAI_COMMANDS_FILE" ]]; then termai_refresh=1; break; fi
    done
  fi
  if ((termai_refresh)); then
    builtin compgen -c > "$TERMAI_COMMANDS_FILE"
    printf '%s\n' "$termai_functions" > "$TERMAI_FUNCTIONS_FILE"
    __termai_catalog_path="$PATH" __termai_catalog_cwd="$PWD" __termai_catalog_functions="$termai_functions" __termai_catalog_aliases="$termai_aliases" __termai_catalog_at=$SECONDS
  fi
  while IFS= read -r termai_env_name; do
    builtin printf '%s=%s\0' "$termai_env_name" "${!termai_env_name}"
  done < <(builtin compgen -e) > "$TERMAI_ENV_FILE"

  {
    builtin declare -f
    builtin complete -p
    local termai_completion_var
    while IFS= read -r termai_completion_var; do
      case "$termai_completion_var" in
        _*|*COMPLETION*|COMP_WORDBREAKS)
          builtin declare -p "$termai_completion_var" 2>/dev/null ;;
      esac
    done < <(builtin compgen -A variable)
  } > "$TERMAI_COMPLETIONS_FILE.tmp"
  command mv -f -- "$TERMAI_COMPLETIONS_FILE.tmp" "$TERMAI_COMPLETIONS_FILE"

  # Remote programs may leave the cursor above old output. Clear the unused area
  # before drawing our next prompt, without erasing output above or scrollback.
  printf '\033[J\033]777;termai;%s;prompt;%s;%s\007' "$TERMAI_NONCE" "$termai_status" "$(printf '%s\0%s' "$PWD" "$(HISTTIMEFORMAT= builtin history 1)" | command base64)"
}

__termai_capture_herdr() {
  local termai_pattern='^[[:space:]]*((/[^[:space:]]*/)?herdr)([[:space:]]+--session[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}|[[:space:]]+session[[:space:]]+attach[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?[[:space:]]*$'
  [[ "$READLINE_LINE" =~ $termai_pattern ]] || return 1
  local termai_binary; read -r termai_binary _ <<< "$READLINE_LINE"
  [[ "$(builtin type -t "$termai_binary")" == file ]] || return 1
  [[ "$READLINE_LINE" == [[:space:]]* ]] || builtin history -s "$READLINE_LINE"
  printf '\r\n\033]777;termai;%s;herdr;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$READLINE_LINE" | command base64)"
  READLINE_LINE= READLINE_POINT=0
}


__termai_ssh_passthrough() {
  local termai_definition termai_line termai_names=' ' termai_name termai_row=0
  termai_definition="$(builtin declare -f ssh)" || return 1
  while IFS=$' \t' read -r termai_line; do
    ((termai_row+=1))
    if ((termai_row == 1)); then [[ "$termai_line" == 'ssh ()' ]] || return 1; continue; fi
    if ((termai_row == 2)); then [[ "$termai_line" == '{' ]] || return 1; continue; fi
    termai_line="${termai_line%;}"
    if [[ "$termai_line" == 'command ssh "$@"' || "$termai_line" == '/usr/bin/ssh "$@"' || "$termai_line" == '/bin/ssh "$@"' ]]; then
      return 0
    elif [[ "$termai_line" =~ ^local[[:space:]]+([a-z_][a-z_0-9[:space:]]*)$ ]]; then
      for termai_name in ${BASH_REMATCH[1]}; do
        [[ "$termai_name" =~ ^[a-z_][a-z_0-9]*$ && "$termai_name" != termai_* ]] || return 1
        termai_names+="$termai_name "
      done
    elif [[ "$termai_line" =~ ^([a-z_][a-z_0-9]*)=\$(SECONDS|\?)$ ]]; then
      [[ "$termai_names" == *" ${BASH_REMATCH[1]} "* ]] || return 1
    else
      return 1
    fi
  done <<< "$termai_definition"
  return 1
}


builtin unalias upload download 2>/dev/null || :
function upload {
  if (( $# > 1 )); then printf '%s\n' 'Usage: upload [DIRECTORY]' >&2; return 2; fi
  local termai_destination="${1:-$PWD}"
  [[ "$termai_destination" == /* ]] || termai_destination="$PWD/$termai_destination"
  if [[ ! -d "$termai_destination" ]]; then printf '%s\n' 'Upload destination is not a directory.' >&2; return 1; fi
  printf '\033]777;termai;%s;transfer-upload;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$termai_destination" | command base64)" > /dev/tty
}
function download { (
  local termai_file termai_name termai_size termai_mode=auto
  if [[ "${1-}" == --file ]]; then termai_mode=file; shift; fi
  if [[ "${1-}" == -- ]]; then shift; fi
  if (( $# > 1 )); then printf '%s\n' 'Usage: download FILE  OR  command | download [NAME]' >&2; return 2; fi
  if [[ -t 0 || "$termai_mode" == file ]]; then
    if (( $# != 1 )) || [[ ! -f "$1" ]]; then printf '%s\n' 'Usage: download FILE  OR  command | download [NAME]' >&2; return 2; fi
    termai_file="$1"; [[ "$termai_file" == /* ]] || termai_file="$PWD/$termai_file"
    printf '\033]777;termai;%s;transfer-download;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$termai_file" | command base64)" > /dev/tty
    return
  fi
  termai_name="${1:-command-output.txt}"
  if [[ "$termai_name" == */* || "$termai_name" == *\\* || "$termai_name" =~ [[:cntrl:]] || "$termai_name" == '.' || "$termai_name" == '..' || ${#termai_name} -gt 255 ]]; then printf '%s\n' 'Use a filename for the downloaded output.' >&2; return 2; fi
  termai_file="$(command mktemp "$TERMAI_TRANSFER_DIR/download.XXXXXXXX")" || return
  trap 'command rm -f -- "$termai_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  command head -c 1073741825 > "$termai_file" || return
  termai_size="$(command wc -c < "$termai_file")" || return
  if (( termai_size > 1073741824 )); then printf '%s\n' 'Piped downloads are limited to 1 GB.' >&2; return 1; fi
  printf '\033]777;termai;%s;transfer-capture;%s;%s\007' "$TERMAI_NONCE" "${termai_file##*/}" "$(printf '%s' "$termai_name" | command base64)" > /dev/tty || return
  trap - EXIT
); }


__termai_read() (
  local termai_mode=auto termai_target termai_file termai_code=0 termai_size
  case "${1-}" in
    --file) termai_mode=file; shift ;;
    --command) termai_mode=command; shift ;;
    --) shift ;;
  esac
  termai_target="$(IFS=' '; printf '%s' "$*")"
  if (( $# )) && [[ "$termai_mode" != command ]] && {
    [[ -e "$termai_target" || "$termai_mode" == file ]] || ! builtin type -t -- "$1" >/dev/null;
  }; then
    [[ "$termai_target" == /* ]] || termai_target="$PWD/$termai_target"
    printf '\033]777;termai;%s;reading-file;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$termai_target" | command base64)" > /dev/tty
    return
  fi
  if (( $# == 0 )) && [[ -t 0 ]]; then
    printf '%s\n' 'Usage: command | look at  OR  look at FILE  OR  look at COMMAND [ARGS…]' >&2
    return 2
  fi
  termai_file="$(command mktemp "$TERMAI_READING_DIR/read.XXXXXXXX")" || return
  trap 'command rm -f -- "$termai_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if (( $# )); then
    if "$@" | command head -c 20971521 > "$termai_file"; then
      termai_code=${PIPESTATUS[0]}
    else
      termai_code=${PIPESTATUS[0]}
    fi
  else
    command head -c 20971521 > "$termai_file" || return
    termai_target='Command output'
  fi
  termai_size="$(command wc -c < "$termai_file")" || return
  if (( termai_size > 20971520 )); then
    printf '%s\n' 'Reading Mode output exceeds the 20 MB limit.' >&2
    return 1
  fi
  printf '\033]777;termai;%s;reading-capture;%s;%s;%s\007' "$TERMAI_NONCE" "${termai_file##*/}" "$(printf '%s' "$termai_target" | command base64)" "$termai_code" > /dev/tty || return
  trap - EXIT
  return "$termai_code"
)
# The utility is session-local; other uses of the system look command still work.
builtin unalias look 2>/dev/null || :
function look {
  if [[ "${1-}" == at ]]; then shift; __termai_read "$@"; else command look "$@"; fi
}


__termai_history_segment() {
  [[ "$1" =~ ^[[:space:]]*(upload|download|__termai_read)([[:space:]]|$) ||
     "$1" =~ ^[[:space:]]*look[[:space:]]+at([[:space:]]|$) ]]
}
__termai_history_special() {
  local termai_line="$1" termai_segment= termai_quote= termai_char
  local termai_at termai_depth=0 termai_escape=0
  for ((termai_at=0; termai_at<${#termai_line}; termai_at++)); do
    termai_char="${termai_line:termai_at:1}"
    if ((termai_escape)); then
      termai_segment+="$termai_char"; termai_escape=0; continue
    fi
    if [[ "$termai_char" == '\' && "$termai_quote" != "'" ]]; then
      termai_segment+="$termai_char"; termai_escape=1; continue
    fi
    if [[ -n "$termai_quote" ]]; then
      [[ "$termai_char" != "$termai_quote" ]] || termai_quote=
      termai_segment+="$termai_char"; continue
    fi
    case "$termai_char" in
      "'"|'"'|'`') termai_quote="$termai_char"; termai_segment+="$termai_char" ;;
      '('|'{') termai_depth=$((termai_depth + 1)); termai_segment+="$termai_char" ;;
      ')'|'}') termai_depth=$((termai_depth - 1)); termai_segment+="$termai_char" ;;
      '|'|';'|'&')
        if ((termai_depth == 0)); then
          if __termai_history_segment "$termai_segment"; then return 0; fi
          termai_segment=
        else termai_segment+="$termai_char"; fi ;;
      '#')
        if ((termai_depth == 0)) && [[ -z "$termai_segment" || "$termai_segment" == *[[:space:]] ]]; then break; fi
        termai_segment+="$termai_char" ;;
      *) termai_segment+="$termai_char" ;;
    esac
  done
  __termai_history_segment "$termai_segment"
}

# Readline owns history, completion and pasted text. Inspect its final buffer,
# prefix managed utilities for ignorespace and divert local SSH connections.
__termai_accept() {
  if [[ "$READLINE_LINE" != ' '* ]] && __termai_history_special "$READLINE_LINE"; then
    READLINE_LINE=" $READLINE_LINE"
    READLINE_POINT=$((READLINE_POINT + 1))
  fi
  if __termai_capture_herdr; then return; fi
  if [[ "$TERMAI_CAPTURE_SSH" == 1 && "$READLINE_LINE" =~ ^[[:space:]]*(ssh|/usr/bin/ssh)[[:space:]] && ! "$READLINE_LINE" =~ [[:cntrl:]] && ${#READLINE_LINE} -le 4000 ]]; then
    # Preserve custom SSH behavior, but allow wrappers that immediately forward
    # the same arguments (such as reconnect/terminal-cleanup wrappers).
    if [[ "$READLINE_LINE" =~ ^[[:space:]]*ssh[[:space:]] ]]; then
      local termai_kind="$(builtin type -t ssh)"
      if [[ "$termai_kind" == function ]]; then
        __termai_ssh_passthrough || return
      elif [[ "$termai_kind" != file ]]; then
        return
      fi
      local termai_ssh="$(builtin type -P ssh)"
      [[ "$termai_ssh" == /usr/bin/ssh || "$termai_ssh" == /bin/ssh ]] || return
    fi
    [[ "$READLINE_LINE" == [[:space:]]* ]] || builtin history -s "$READLINE_LINE"
    printf '\r\n\033]777;termai;%s;ssh;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$READLINE_LINE" | command base64)"
    READLINE_LINE= READLINE_POINT=0
  fi
}
bind -x '"\C-x\C-t":__termai_accept'
bind '"\C-m":"\C-x\C-t\C-j"'
PROMPT_COMMAND=(__termai_prompt)
PS0=$'\033]777;termai;'"$TERMAI_NONCE"$';busy\007'
PS1='\[\e[38;5;114m\]\w\[\e[0m\] $ '
set -o history
